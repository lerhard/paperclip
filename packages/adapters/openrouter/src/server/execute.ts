/**
 * OpenRouter adapter execute() — multi-turn tool loop.
 *
 * Responsibilities:
 *   - Build messages from Paperclip wake context + skills
 *   - Run a tool-calling loop against OpenRouter's chat/completions endpoint
 *   - Manage issue state (in_progress at start, done/blocked at end)
 *   - Post the final assistant output as an issue comment
 *   - Emit typed TranscriptEntry lines so the run viewer renders properly
 *   - Track usage and cost via OpenRouter's /generation endpoint
 *
 * Out of scope for v1 (deferred to v3):
 *   - Token streaming inside the tool loop (non-streaming is more reliable
 *     for tool calls on free models)
 *   - Approval gate handling (we route hire_agent through approvals, but we
 *     don't yet pause-and-resume runs on async approval callbacks)
 *   - Workspace runtime env vars (we have no child process to pass them to)
 *   - Attachment / multimodal handling
 */

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import fs from "node:fs/promises";
import {
  renderPaperclipWakePrompt,
  parseObject,
  asString,
  renderTemplate,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";

import {
  OPENROUTER_CHAT_ENDPOINT,
  OPENROUTER_GENERATION_ENDPOINT,
  type OpenRouterConfig,
} from "../index.js";
import { PaperclipApi, PaperclipApiError } from "./paperclip-api.js";
import { buildTools, toolSchemas, findTool, type Tool } from "./tools.js";
import { loadSkills, renderSkillsForPrompt } from "./skills.js";
import {
  emitInit,
  emitAssistant,
  emitThinking,
  emitToolCall,
  emitToolResult,
  emitResult,
  emitSystem,
  writeRawStderr,
  type OnLog,
} from "./transcript.js";
import { compressToolResult, estimateTokenSavings } from "./compression.js";

// ----- types matching OpenRouter / OpenAI chat completions -----

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    finish_reason: string | null;
    message: {
      role: "assistant";
      content: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

// ----- helpers -----

const DEFAULT_MAX_TURNS = 12;
const DEFAULT_SYSTEM_PROMPT = "Exec tools only. End status=done + summary.";
const FREE_TIER_TURN_DELAY_MS = 1500; // proactive delay to avoid rate limits

const TRANSIENT_UPSTREAM_RE =
  /(?:rate[-\s]?limit(?:ed)?|rate_limit_error|too\s+many\s+requests|\b429\b|overloaded(?:_error)?|server\s+overloaded|service\s+unavailable|\b502\b|\b503\b|\b529\b|provider\s+returned\s+error|high\s+demand|try\s+again\s+later|temporarily\s+unavailable|throttl(?:ed|ing)|throttlingexception|servicequotaexceededexception|out\s+of\s+extra\s+usage|extra\s+usage\b|usage\s+limit\s+reached|usage\s+cap\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached)/i;

const API_STDERR_NOISE_RE =
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+(?:DEBUG|INFO)\s+.*$/i;

function isTransientError(errText: string): boolean {
  return TRANSIENT_UPSTREAM_RE.test(errText);
}

function extractRetryNotBefore(errText: string): string | null {
  const relativeMatch = errText.match(/in\s+(\d+)\s*(minute|hour|second)s?/i);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1] ?? "0", 10);
    const unit = relativeMatch[2]?.toLowerCase() ?? "minute";
    const ms = unit.startsWith("hour") ? amount * 3600_000 : unit.startsWith("second") ? amount * 1000 : amount * 60_000;
    return new Date(Date.now() + ms).toISOString();
  }
  return null;
}

function cleanStderr(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed && !API_STDERR_NOISE_RE.test(trimmed);
    })
    .join("\n");
}

function isFreeTierModel(model: string): boolean {
  return model.endsWith(":free") || model === "openrouter/auto";
}

/**
 * Collect all available OpenRouter API keys into a round-robin pool.
 * Priority: config.apiKey > OPENROUTER_API_KEY > OPENROUTER_API_KEY_2,3...
 */
function collectApiKeys(config: OpenRouterConfig): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();

  // Primary key from config
  if (config.apiKey) {
    keys.push(config.apiKey);
    seen.add(config.apiKey);
  }

  // Primary env key
  const primaryEnv = process.env.OPENROUTER_API_KEY;
  if (primaryEnv && !seen.has(primaryEnv)) {
    keys.push(primaryEnv);
    seen.add(primaryEnv);
  }

  // Fallback keys OPENROUTER_API_KEY_2 through _20
  for (let i = 2; i <= 20; i++) {
    const key = process.env[`OPENROUTER_API_KEY_${i}`];
    if (key && !seen.has(key)) {
      keys.push(key);
      seen.add(key);
    }
  }

  return keys;
}

function resolveApiKey(config: OpenRouterConfig, useFallback = false): string {
  if (useFallback) {
    const fallbackKey = process.env.OPENROUTER_API_KEY_FALLBACK || "";
    if (fallbackKey) {
      return fallbackKey;
    }
  }

  const key = config.apiKey || process.env.OPENROUTER_API_KEY || "";
  if (!key) {
    throw new Error(
      "OpenRouter API key not found. Set adapterConfig.apiKey or OPENROUTER_API_KEY env var.",
    );
  }
  return key;
}

/**
 * Extract rate-limit reset timestamp from response headers (in ms).
 * Falls back to Date header + 60s if not present.
 */
function extractRateLimitReset(response: Response): number {
  const resetHeader = response.headers.get("x-ratelimit-reset");
  if (resetHeader) {
    const ts = parseInt(resetHeader, 10);
    if (!isNaN(ts)) return ts;
  }
  // OpenRouter returns reset as epoch ms; if missing, default to 60s from now
  return Date.now() + 60_000;
}

/**
 * Sleep for a given duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveBillingType(config: OpenRouterConfig): "api" | "subscription" {
  // OpenRouter is always API-key based.
  if (config.apiKey || process.env.OPENROUTER_API_KEY) return "api";
  return "api";
}

function buildHeaders(apiKey: string, config: OpenRouterConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": config.httpReferer || "https://paperclip.ing",
    "X-Title": config.xTitle || "Paperclip",
  };
}

function extractCurrentIssueId(context: Record<string, unknown>): string | null {
  const candidates = [
    context.taskId,
    context.issueId,
    context.wakeTaskId,
    (context.paperclipWake as Record<string, unknown> | undefined)?.taskId,
    (context.paperclipWake as Record<string, unknown> | undefined)?.issueId,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return null;
}

function safeParseToolArgs(raw: string): Record<string, unknown> {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

interface RateLimitStatus {
  limit: number;
  remaining: number;
  resetTs: number;
  used: number; // cumulative requests made with this key in this run
}

function maskKey(key: string): string {
  return key.length > 12 ? key.slice(0, 8) + "..." + key.slice(-4) : "***";
}

function extractRateLimitStatus(response: Response): RateLimitStatus {
  const limit = parseInt(response.headers.get("x-ratelimit-limit") || "0", 10);
  const remaining = parseInt(response.headers.get("x-ratelimit-remaining") || "0", 10);
  const resetTs = extractRateLimitReset(response);
  return { limit: isNaN(limit) ? 0 : limit, remaining: isNaN(remaining) ? 0 : remaining, resetTs, used: 0 };
}

function formatRateLimitReset(resetTs: number): string {
  const now = Date.now();
  const ms = Math.max(0, resetTs - now);
  if (ms <= 0) return "now";
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
}

async function callOpenRouter(
  _apiKey: string,
  config: OpenRouterConfig,
  messages: ChatMessage[],
  tools: Tool[],
  onLog?: OnLog,
): Promise<{ response: ChatCompletionResponse; usedKey: string; rateLimit: RateLimitStatus }> {
  const resolvedModel = config.model || "openrouter/auto";
  const isFree = isFreeTierModel(resolvedModel);
  const body: Record<string, unknown> = {
    model: resolvedModel,
    messages,
    max_tokens: config.maxTokens ?? (isFree ? 2048 : 4096),
    temperature: config.temperature ?? 0.7,
    top_p: config.topP ?? 1,
    stream: false,
  };
  if (tools.length > 0) {
    body.tools = toolSchemas(tools);
    body.tool_choice = "auto";
  }
  if (config.reasoning) body.reasoning = { effort: "high" };
  if (config.transforms?.length) body.transforms = config.transforms;
  if (config.route) body.route = config.route;

  const allKeys = collectApiKeys(config);
  if (allKeys.length === 0) {
    throw new Error("No OpenRouter API keys available.");
  }

  const MAX_RETRIES = 5;
  let lastErrText = "";

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Round-robin: pick key based on attempt index so each retry cycles keys
    const keyIndex = attempt % allKeys.length;
    const currentKey = allKeys[keyIndex];

    const response = await fetch(OPENROUTER_CHAT_ENDPOINT, {
      method: "POST",
      headers: buildHeaders(currentKey, config),
      body: JSON.stringify(body),
    });

    if (response.ok) {
      const json = (await response.json()) as ChatCompletionResponse;
      const rateLimit = extractRateLimitStatus(response);
      return { response: json, usedKey: currentKey, rateLimit };
    }

    lastErrText = await response.text().catch(() => "");

    // ── 429 Rate limit ──
    if (response.status === 429) {
      // Extract reset timestamp from headers (OpenRouter sends epoch ms)
      const resetTs = extractRateLimitReset(response);
      const now = Date.now();
      const waitMs = Math.max(0, resetTs - now);
      const waitSec = Math.ceil(waitMs / 1000);

      // Determine if it's daily or per-minute limit
      const isDailyLimit = lastErrText.includes("free-models-per-day");
      const isMinLimit = lastErrText.includes("free-models-per-min");

      if (isDailyLimit) {
        // Daily limit: this key is exhausted, try next on next attempt
        if (onLog) {
          await writeRawStderr(
            onLog,
            `[openrouter] Daily limit on key #${keyIndex + 1} (${maskKey(currentKey)}). Rotating to next key...`
          );
        }
        // Continue to next attempt which will use the next key
        continue;
      }

      if (isMinLimit && waitMs > 0) {
        // Per-minute limit: wait until reset, then retry
        if (onLog) {
          await writeRawStderr(
            onLog,
            `[openrouter] Rate limit (per-min) — waiting ${waitSec}s for reset (key #${keyIndex + 1}/${allKeys.length} ${maskKey(currentKey)}, attempt ${attempt + 1}/${MAX_RETRIES})...`
          );
        }
        await sleep(waitMs + 500); // +500ms buffer
        continue; // Retry with same or next key
      }

      // Generic 429 — backoff exponentially
      const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30_000);
      if (onLog) {
        await writeRawStderr(
          onLog,
          `[openrouter] Rate limit (generic 429) — backing off ${backoffMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`
        );
      }
      await sleep(backoffMs);
      continue;
    }

    // ── 400 Context length ──
    if (response.status === 400) {
      const isContextLength = /maximum context length|context length is|too many tokens|requested about \d+ tokens/i.test(lastErrText);
      if (isContextLength && Array.isArray(body.messages)) {
        const msgs = body.messages as ChatMessage[];

        // Strategy 1: drop older non-system messages (keep system + last half)
        if (msgs.length > 3) {
          const keepCount = Math.max(2, Math.floor(msgs.length / 2));
          const systemMsg = msgs[0];
          const recent = msgs.slice(-keepCount);
          const newMsgs = [systemMsg, ...recent];
          body.messages = newMsgs;
          if (onLog) {
            await writeRawStderr(
              onLog,
              `[openrouter] Context too long, truncating ${msgs.length} → ${newMsgs.length} messages (attempt ${attempt + 1}/${MAX_RETRIES})...`,
            );
          }
          continue;
        }

        // Strategy 2: truncate individual message contents
        const maxChars = 6000;
        let anyTruncated = false;
        body.messages = msgs.map((m, i) => {
          if (i === 0) return m; // preserve system
          const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
          if (content.length > maxChars) {
            anyTruncated = true;
            return { ...m, content: content.slice(0, maxChars) + "\n... [truncated by context limit]" };
          }
          return m;
        });
        if (anyTruncated) {
          if (onLog) {
            await writeRawStderr(
              onLog,
              `[openrouter] Context too long, truncating long message contents (attempt ${attempt + 1}/${MAX_RETRIES})...`,
            );
          }
          continue;
        }
      }

      // Non-context-length 400 — don't retry
      throw new Error(`OpenRouter API error (${response.status}): ${lastErrText}`);
    }

    // Non-429 / non-400-context-length error — don't retry
    throw new Error(`OpenRouter API error (${response.status}): ${lastErrText}`);
  }

  throw new Error(`OpenRouter API error (429): All ${allKeys.length} key(s) exhausted after ${MAX_RETRIES} attempts. ${lastErrText}`);
}

async function fetchGenerationCost(
  generationId: string,
  apiKey: string,
): Promise<{ costUsd: number | null; inputTokens: number; outputTokens: number }> {
  const fallback = { costUsd: null as number | null, inputTokens: 0, outputTokens: 0 };
  try {
    // OpenRouter's /generation endpoint takes a moment to populate.
    await new Promise((r) => setTimeout(r, 1500));
    const res = await fetch(`${OPENROUTER_GENERATION_ENDPOINT}?id=${encodeURIComponent(generationId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return fallback;
    const data = (await res.json()) as { data?: Record<string, unknown> };
    const d = data.data ?? {};
    return {
      costUsd: typeof d.total_cost === "number" ? d.total_cost : null,
      inputTokens: typeof d.tokens_prompt === "number" ? d.tokens_prompt : 0,
      outputTokens: typeof d.tokens_completion === "number" ? d.tokens_completion : 0,
    };
  } catch {
    return fallback;
  }
}

// ----- main -----

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = (ctx.agent.adapterConfig ?? ctx.config) as unknown as OpenRouterConfig;
  const { context, onLog, onMeta, agent, authToken } = ctx;

  const model = config.model || "openrouter/auto";
  const maxTurns = typeof config.maxTurns === "number" && config.maxTurns > 0 ? config.maxTurns : DEFAULT_MAX_TURNS;
  const autoApprove = config.autoApprove === true;
  const maxContextMessages = typeof config.maxContextMessages === "number" && config.maxContextMessages > 0 
    ? config.maxContextMessages 
    : isFreeTierModel(model) ? 10 : undefined;
  const compressToolResults = config.compressToolResults === true;
  const useRTK = config.useRTK === true;
  const useCaveman = config.useCaveman === true;

  // Tool handlers need a Paperclip API client. If we have no authToken,
  // tools are disabled (model can still respond, just can't act).
  let api: PaperclipApi | null = null;
  let tools: Tool[] = [];
  const currentIssueId = extractCurrentIssueId(context);
  const companyId = agent.companyId;

  if (authToken) {
    api = new PaperclipApi({ authToken });
    tools = buildTools({
      api,
      agentId: agent.id,
      companyId,
      currentIssueId,
      autoApprove,
    });
  } else {
    await writeRawStderr(
      onLog,
      "[openrouter] No authToken on context — tool calls disabled. Agent can only generate text.",
    );
  }

  // Emit init early so the run viewer renders the header.
  await emitInit(onLog, { model, sessionId: ctx.runId });

  // Log active configuration so the operator can verify settings in the transcript.
  const activeConfigParts: string[] = [`maxTurns=${maxTurns}`];
  if (maxContextMessages) activeConfigParts.push(`maxContextMessages=${maxContextMessages}`);
  if (compressToolResults) activeConfigParts.push("compressToolResults=true");
  if (useRTK) activeConfigParts.push("useRTK=true");
  if (useCaveman) activeConfigParts.push("useCaveman=true");
  if (autoApprove) activeConfigParts.push("autoApprove=true");
  await emitSystem(
    onLog,
    `OpenRouter adapter active config: ${activeConfigParts.join(", ")}`
  );

  // ----- build messages -----

  let messages: ChatMessage[] = [];

  // System prompt = base + skills + optional instructions file
  let systemContent = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

  // If promptTemplate is set, render it with template data (mirrors claude/codex)
  const promptTemplate = (config as unknown as Record<string, unknown>).promptTemplate;
  if (typeof promptTemplate === "string" && promptTemplate.trim().length > 0) {
    const templateData: Record<string, unknown> = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId: ctx.runId,
      issueId: (context.issueId as string) ?? "",
      issueTitle: typeof context.issueTitle === "string" ? context.issueTitle : "",
      model,
    };
    systemContent = renderTemplate(promptTemplate.trim(), templateData);
  }

  // If instructionsFilePath is set, read the file and use it as the base.
  // This mirrors the behavior of claude-local / codex-local / etc., letting
  // operators version-control long agent instructions in a markdown file
  // instead of pasting them into the inline systemPrompt field.
  const instructionsFilePath = (config as unknown as Record<string, unknown>).instructionsFilePath;
  if (typeof instructionsFilePath === "string" && instructionsFilePath.trim().length > 0) {
    try {
      const fileContent = await fs.readFile(instructionsFilePath.trim(), "utf8");
      if (fileContent.trim().length > 0) {
        systemContent = fileContent.trim();
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(
        onLog,
        `[openrouter] could not read instructionsFilePath ${instructionsFilePath}: ${reason}. Falling back to systemPrompt.`,
      );
    }
  }
  try {
    const skills = await loadSkills({ agentConfig: config as unknown as Record<string, unknown>, onLog });
    if (skills.length > 0) {
      systemContent = `${systemContent}\n\n${renderSkillsForPrompt(skills)}`;
      await emitSystem(onLog, `Loaded ${skills.length} skill(s): ${skills.map((s) => s.name).join(", ")}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await writeRawStderr(onLog, `[openrouter] skill loading error (continuing): ${reason}`);
  }
  messages.push({ role: "system", content: systemContent });

  // User prompt = Paperclip wake payload rendered as text
  const resumedSession = !!ctx.runtime.sessionId;
  let wakePrompt = "";
  try {
    wakePrompt = renderPaperclipWakePrompt(context, { resumedSession }) || "";
  } catch {
    wakePrompt = "";
  }
  const userContent = wakePrompt || JSON.stringify(context);
  messages.push({
    role: "user",
    content: userContent,
  });

  if (onMeta) {
    await onMeta({
      adapterType: "openrouter",
      command: model,
      prompt: `${systemContent}\n\n${userContent}`,
      promptMetrics: {
        promptChars: systemContent.length + userContent.length,
        maxTurns,
        toolsCount: tools.length,
      },
      context: { model },
    });
  }

  // ----- check out issue (acquire run lock) -----
  //
  // Paperclip's sameRunLock check rejects any write to an issue (comments,
  // status changes, etc.) unless the issue's checkoutRunId matches the
  // calling run id. The CLI adapters get this for free because Paperclip's
  // wake handler pre-checks-out the issue for them; pure-HTTP adapters
  // don't, so we have to do it ourselves before any tool can mutate state.
  //
  // If checkout fails (issue locked by another live run, project paused,
  // etc.), we log and proceed without tools — same graceful degradation
  // we apply when authToken is missing.

  // If Paperclip's heartbeat dispatcher already stamped this run as the
  // issue's executionRunId, the lock is effectively held by us already and
  // an explicit checkout call would be redundant (and on some Paperclip
  // versions, return a validation error). Detect that and skip.
  const preLocked = (() => {
    const wakeIssue = (context.paperclipWake as Record<string, unknown> | undefined)?.issue as
      | Record<string, unknown>
      | undefined;
    const ctxIssue = (context.issue as Record<string, unknown> | undefined) ?? wakeIssue;
    const execRunId =
      typeof ctxIssue?.executionRunId === "string" ? ctxIssue.executionRunId : null;
    return !!execRunId && execRunId === ctx.runId;
  })();

  let issueLocked = preLocked;
  if (api && currentIssueId && !preLocked) {
    try {
      await api.checkoutIssue(currentIssueId, agent.id);
      issueLocked = true;
    } catch (err) {
      // Best-effort: many runs are dispatched by the heartbeat which already
      // holds the lock for us, so a checkout failure is not necessarily
      // fatal. We try the writes anyway and let Paperclip enforce the real
      // ownership check at write time.
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(
        onLog,
        `[openrouter] checkout call failed for ${currentIssueId}: ${reason}. Continuing — Paperclip may still accept writes if the heartbeat pre-locked the issue.`,
      );
      issueLocked = true;
    }
  }

  // ----- mark issue in_progress -----

  if (api && currentIssueId && issueLocked) {
    try {
      await api.updateIssue(currentIssueId, { status: "in_progress" });
    } catch (err) {
      // Don't fail the run for status updates.
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(onLog, `[openrouter] could not set issue in_progress: ${reason}`);
    }
  }

  // ----- tool loop -----

  let apiKey: string;
  try {
    apiKey = resolveApiKey(config);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await writeRawStderr(onLog, `[openrouter] ${reason}\n`);
    if (api && currentIssueId) {
      await api
        .updateIssue(currentIssueId, { status: "blocked", statusReason: reason })
        .catch(() => undefined);
    }
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: reason,
      errorCode: "missing_api_key",
      usage: { inputTokens: 0, outputTokens: 0 },
      model,
      provider: "openrouter",
      biller: "openrouter",
      billingType: resolveBillingType(config),
    };
  }

  let lastGenerationId: string | undefined;
  let totalUsage: UsageSummary = { inputTokens: 0, outputTokens: 0 };
  let finalAssistantText = "";
  let turn = 0;
  let stoppedReason: "completed" | "max_turns" | "error" | "repeat_loop" = "completed";
  let runError: { message: string; code: string } | null = null;
  // Repeat-call detection: if the model calls the same tool with the same args
  // three times in a row, break the loop. Prevents 20+ retries when the model
  // misreads an error message and keeps "fixing" it the same wrong way.
  const recentCalls: string[] = [];
  const REPEAT_THRESHOLD = 3;
  // Track per-key usage across the entire run
  const keyUsage = new Map<string, { requests: number; rateLimit: RateLimitStatus }>();

  // Tool result cache: avoid re-executing same tool with same args across turns
  const toolResultCache = new Map<string, { content: string; isError: boolean }>();

  await emitSystem(onLog, `[openrouter] Starting tool loop: maxTurns=${maxTurns}, tools=${tools.length}, authToken=${!!authToken}`);

  try {
    while (turn < maxTurns) {
      turn += 1;
      await emitSystem(onLog, `[Turn ${turn}/${maxTurns}] Starting...`);

      // Proactive delay for free tier: respect rate limits before hitting them
      if (turn > 1 && isFreeTierModel(model)) {
        await sleep(FREE_TIER_TURN_DELAY_MS);
      }

      // Truncate message history if maxContextMessages is set (token optimization)
      let messagesToSend = messages;
      if (maxContextMessages && messages.length > maxContextMessages + 1) {
        // Always keep system message (index 0) + last N messages
        const systemMsg = messages[0];
        const recentMessages = messages.slice(-(maxContextMessages));
        messagesToSend = [systemMsg, ...recentMessages];
        
        if (turn === 1) {
          await writeRawStderr(
            onLog,
            `[openrouter] Token optimization: keeping system + last ${maxContextMessages} messages (${messagesToSend.length}/${messages.length} total)`
          );
        }
      }

      let response: ChatCompletionResponse;
      try {
        const result = await callOpenRouter(apiKey, config, messagesToSend, tools, onLog);
        response = result.response;
        // Update apiKey if fallback was used
        if (result.usedKey !== apiKey) {
          apiKey = result.usedKey;
        }
        // Track per-key usage
        const masked = maskKey(apiKey);
        const existing = keyUsage.get(masked);
        if (existing) {
          existing.requests++;
          existing.rateLimit = result.rateLimit;
        } else {
          keyUsage.set(masked, { requests: 1, rateLimit: result.rateLimit });
        }
        // Emit visible rate limit status
        const rl = result.rateLimit;
        if (rl.limit > 0) {
          await emitSystem(
            onLog,
            `Rate limit — key ${masked}: ${rl.remaining}/${rl.limit} remaining, resets in ${formatRateLimitReset(rl.resetTs)} (used ${keyUsage.get(masked)?.requests ?? 1}x this run)`
          );
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const cleanedReason = cleanStderr(reason);
        const isTransientErr = isTransientError(cleanedReason);

        // Session/conversation not found => retry with clean messages (mirrors claude/codex)
        const isSessionUnknown = /session.*not found|conversation.*not found|unknown.*run|run.*not found|no conversation found/i.test(cleanedReason);
        if (isSessionUnknown && !isTransientErr) {
          await emitSystem(onLog, "Session not found; retrying with clean messages...");
          messages = [{ role: "system", content: systemContent }];
          continue;
        }

        const extractedRetry = isTransientErr ? extractRetryNotBefore(cleanedReason) : null;
        runError = { message: cleanedReason, code: isTransientErr ? "transient_upstream" : "openrouter_request_failed" };
        stoppedReason = "error";
        if (isTransientErr) {
          (runError as any).errorFamily = "transient_upstream";
          (runError as any).retryNotBefore = extractedRetry ?? new Date(Date.now() + 60_000).toISOString();
        }
        break;
      }

      lastGenerationId = response.id || lastGenerationId;
      if (response.usage) {
        totalUsage = {
          inputTokens: totalUsage.inputTokens + (response.usage.prompt_tokens ?? 0),
          outputTokens: totalUsage.outputTokens + (response.usage.completion_tokens ?? 0),
        };
      }

      const choice = response.choices?.[0];
      if (!choice) {
        await writeRawStderr(onLog, `[openrouter] ERROR: OpenRouter returned no choices in response. Response: ${JSON.stringify(response).slice(0, 500)}`);
        runError = { message: "OpenRouter returned no choices", code: "openrouter_empty_response" };
        stoppedReason = "error";
        break;
      }

      const msg = choice.message;
      const reasoning = typeof msg.reasoning === "string" ? msg.reasoning : "";
      const reasoningContent = typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
      const effectiveReasoning = reasoning || reasoningContent;
      const text = typeof msg.content === "string" ? msg.content : "";
      const toolCalls = msg.tool_calls ?? [];

      if (effectiveReasoning) {
        await emitThinking(onLog, effectiveReasoning);
      }
      if (text) {
        await emitAssistant(onLog, text);
        finalAssistantText = text;
      }

      // Preserve reasoning in context so the model can continue its thought process across turns
      const contextContent = effectiveReasoning && effectiveReasoning.trim().length > 0
        ? `${effectiveReasoning.trim()}\n\n${text}`
        : text;

      // No tool calls => model is done. Early-exit if text clearly signals completion.
      if (toolCalls.length === 0) {
        if (!text && !effectiveReasoning) {
          await writeRawStderr(onLog, `[openrouter] WARNING: Model returned empty response (no text, no reasoning, no tool calls). Treating as completion.`);
        }
        stoppedReason = "completed";
        break;
      }

      // Early-exit: if model says it's done but also included tool calls (rare),
      // detect completion phrases to avoid wasting turns.
      const lowerText = text.toLowerCase();
      const completionPhrases = [
        "status: done",
        "task complete",
        "work is done",
        "finished successfully",
        "completed successfully",
        "nothing more to do",
        "all done",
      ];
      if (completionPhrases.some((p) => lowerText.includes(p))) {
        await emitSystem(onLog, "Early exit: model signaled completion");
        stoppedReason = "completed";
        break;
      }

      // Add the assistant message (with tool_calls) so the model sees its own request.
      messages.push({
        role: "assistant",
        content: contextContent,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      });

      // Execute each tool call and append the results.
      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        const args = safeParseToolArgs(tc.function.arguments);
        await emitToolCall(onLog, { name: toolName, input: args, toolUseId: tc.id });

        const tool = findTool(tools, toolName);
        let resultContent: string;
        let isError: boolean;
        const cacheKey = `${toolName}::${JSON.stringify(args)}`;
        const cached = toolResultCache.get(cacheKey);
        if (cached) {
          resultContent = cached.content;
          isError = cached.isError;
          await emitSystem(onLog, `Cache hit: ${toolName} (skipped re-execution)`);
        } else if (!tool) {
          resultContent = JSON.stringify({ error: `Unknown tool: ${toolName}` });
          isError = true;
        } else {
          try {
            const out = await tool.execute(args);
            resultContent = out.content;
            isError = out.isError;
            toolResultCache.set(cacheKey, { content: resultContent, isError });
          } catch (err) {
            resultContent = JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            });
            isError = true;
          }
        }

        // Apply compression if enabled
        let compressedContent = resultContent;
        let didCompress = false;
        let compressionTechnique = "";
        let originalSize = resultContent.length;
        let compressedSize = originalSize;

        if (compressToolResults && resultContent.length > 100) {
          try {
            // Try to parse as JSON first for structured compression
            const parsed = JSON.parse(resultContent);
            compressedContent = compressToolResult(parsed, {
              useTOON: true,
              useRTK,
              useCaveman: false, // Caveman is for text, not JSON
              useVarman: true,
            });
            didCompress = compressedContent !== resultContent && compressedContent.length < resultContent.length;
            if (didCompress) {
              if (compressedContent.includes("[RTK+TOON]")) compressionTechnique = "RTK+TOON";
              else if (compressedContent.includes("[TOON]")) compressionTechnique = "TOON";
              else if (compressedContent.includes("[RTK]")) compressionTechnique = "RTK";
              else compressionTechnique = "Varman";
            }
          } catch {
            // Not JSON, apply text compression
            compressedContent = compressToolResult(resultContent, {
              useTOON: false,
              useRTK: false,
              useCaveman,
              useVarman: !useCaveman, // Use Varman if not using Caveman
            });
            didCompress = compressedContent !== resultContent && compressedContent.length < resultContent.length;
            if (didCompress) {
              compressionTechnique = useCaveman ? "Caveman" : "Varman";
            }
          }
          compressedSize = compressedContent.length;
        }

        // Log compression stats as a visible system message (not just stderr)
        if (didCompress) {
          const saved = originalSize - compressedSize;
          const pct = Math.round((saved / originalSize) * 100);
          await emitSystem(
            onLog,
            `Compressed ${toolName} result: ${originalSize.toLocaleString()} → ${compressedSize.toLocaleString()} bytes (${pct}% reduction via ${compressionTechnique})`
          );
        }

        await emitToolResult(onLog, {
          toolUseId: tc.id,
          toolName,
          content: resultContent, // Show original in UI for readability
          isError,
        });

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: compressedContent, // Send compressed to model
        });

        // Track repeat calls
        const callSig = `${toolName}::${JSON.stringify(args)}`;
        recentCalls.push(callSig);
        if (recentCalls.length > REPEAT_THRESHOLD) recentCalls.shift();
        if (
          recentCalls.length === REPEAT_THRESHOLD &&
          recentCalls.every((s) => s === callSig)
        ) {
          await writeRawStderr(
            onLog,
            `[openrouter] Tool "${toolName}" called ${REPEAT_THRESHOLD}x with identical args — breaking loop.`,
          );
          runError = {
            message: `Tool "${toolName}" was called ${REPEAT_THRESHOLD} times in a row with identical arguments. The model is stuck in a retry loop.`,
            code: "tool_repeat_loop",
          };
          stoppedReason = "repeat_loop";
          break;
        }
      }
      if (stoppedReason === "repeat_loop") break;
    }

    if (turn >= maxTurns && stoppedReason !== "error") {
      stoppedReason = "max_turns";
      await writeRawStderr(onLog, `[openrouter] hit max_turns (${maxTurns}), stopping`);
    }

    // Log final loop state for debugging silent failures
    await emitSystem(onLog, `[openrouter] Loop exited: turn=${turn}, stoppedReason=${stoppedReason}, finalAssistantText=${finalAssistantText.length > 0 ? "present" : "EMPTY"}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    runError = { message: reason, code: "openrouter_loop_failed" };
    stoppedReason = "error";
    await writeRawStderr(onLog, `[openrouter] Loop exception: ${reason}`);
  }

  // ----- post-loop: cost, comment, status -----

  let costUsd: number | null = null;
  if (lastGenerationId) {
    const cost = await fetchGenerationCost(lastGenerationId, apiKey);
    costUsd = cost.costUsd;
    // Prefer the generation endpoint's token counts when present (more accurate).
    if (cost.inputTokens > 0 || cost.outputTokens > 0) {
      totalUsage = { inputTokens: cost.inputTokens, outputTokens: cost.outputTokens };
    }
  }

  // Post the final assistant text as a comment so other agents can see it.
  if (api && currentIssueId && finalAssistantText.trim().length > 0) {
    try {
      await api.addIssueComment(currentIssueId, { body: finalAssistantText });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(onLog, `[openrouter] could not post final comment: ${reason}`);
    }
  }

  // Update issue status based on outcome.
  if (api && currentIssueId) {
    let nextStatus: string | null = null;
    let statusReason: string | null = null;
    if (stoppedReason === "completed") {
      nextStatus = "done";
    } else if (stoppedReason === "max_turns") {
      // Do NOT mark as blocked — heartbeat simply ran out of turns.
      // Leave the issue as-is so the next heartbeat can continue.
      await emitSystem(onLog, `Heartbeat ended after ${maxTurns} turns. Issue remains open for next cycle.`);
    } else if (stoppedReason === "repeat_loop" && runError) {
      nextStatus = "blocked";
      statusReason = runError.message;
    } else if (stoppedReason === "error" && runError) {
      nextStatus = "blocked";
      statusReason = runError.message;
    }
    if (nextStatus) {
      try {
        await api.updateIssue(currentIssueId, { status: nextStatus, statusReason });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await writeRawStderr(onLog, `[openrouter] could not update final status: ${reason}`);
      }
    }
  }

  // Budget / rate limit summary
  if (keyUsage.size > 0) {
    const summaryLines: string[] = [];
    for (const [masked, data] of keyUsage.entries()) {
      const rl = data.rateLimit;
      const resetIn = formatRateLimitReset(rl.resetTs);
      summaryLines.push(`${masked}: ${data.requests} req, ${rl.remaining}/${rl.limit} rem, resets ${resetIn}`);
    }
    const costLine = costUsd !== null ? `cost=$${costUsd.toFixed(4)}` : "cost=unknown";
    await emitSystem(
      onLog,
      `OpenRouter budget summary — ${costLine}, keys: ${summaryLines.join("; ")}`
    );
  }

  // Emit the final result transcript entry.
  await emitResult(onLog, {
    text: finalAssistantText,
    inputTokens: totalUsage.inputTokens,
    outputTokens: totalUsage.outputTokens,
    costUsd: costUsd ?? 0,
    subtype: stoppedReason,
    isError: stoppedReason === "error",
    errors: runError ? [runError.message] : [],
  });

  // Build sessionParams with rate limit data for Costs -> Providers dashboard
  const sessionParams: Record<string, unknown> = {};
  if (lastGenerationId) sessionParams.lastGenerationId = lastGenerationId;
  if (keyUsage.size > 0) {
    const rateLimits: Record<string, unknown> = {};
    for (const [masked, data] of keyUsage.entries()) {
      const rl = data.rateLimit;
      rateLimits[masked] = {
        requests: data.requests,
        remaining: rl.remaining,
        limit: rl.limit,
        resetInSec: Math.max(0, Math.ceil((rl.resetTs - Date.now()) / 1000)),
      };
    }
    sessionParams.openrouterRateLimits = rateLimits;
  }

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceId = asString((workspaceContext as any).workspaceId, "");
  const workspaceRepoUrl = asString((workspaceContext as any).repoUrl, "");
  const workspaceRepoRef = asString((workspaceContext as any).repoRef, "");
  if (workspaceId) sessionParams.workspaceId = workspaceId;
  if (workspaceRepoUrl) sessionParams.repoUrl = workspaceRepoUrl;
  if (workspaceRepoRef) sessionParams.repoRef = workspaceRepoRef;

  const isMaxTurns = stoppedReason === "max_turns";
  const isError = stoppedReason === "error";
  const hasTransientError = isError && (runError as any)?.errorFamily === "transient_upstream";
  const shouldClearSession = isMaxTurns || (isError && !hasTransientError);

  if (stoppedReason === "error" && runError) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: runError.message,
      errorCode: runError.code,
      errorFamily: hasTransientError ? "transient_upstream" : null,
      retryNotBefore: hasTransientError ? (runError as any).retryNotBefore ?? null : null,
      resultJson: { stopReason: runError.code, detail: runError.message },
      usage: totalUsage,
      model,
      provider: "openrouter",
      biller: "openrouter",
      billingType: resolveBillingType(config),
      costUsd,
      clearSession: shouldClearSession,
      sessionId: lastGenerationId ?? null,
      sessionDisplayId: lastGenerationId ?? null,
      sessionParams: Object.keys(sessionParams).length > 0 ? sessionParams : null,
    };
  }

  return {
    exitCode: isMaxTurns ? 1 : 0,
    signal: null,
    timedOut: false,
    errorMessage: isMaxTurns ? `Hit max_turns (${maxTurns}) without completing` : null,
    errorCode: isMaxTurns ? "max_turns_exhausted" : null,
    errorFamily: isMaxTurns ? "transient_upstream" : null,
    resultJson: isMaxTurns ? { stopReason: "max_turns_exhausted" } : { stopReason: "completed" },
    usage: totalUsage,
    model,
    provider: "openrouter",
    biller: "openrouter",
    billingType: resolveBillingType(config),
    costUsd,
    clearSession: shouldClearSession,
    sessionId: lastGenerationId ?? null,
    sessionDisplayId: lastGenerationId ?? null,
    sessionParams: Object.keys(sessionParams).length > 0 ? sessionParams : null,
    summary: finalAssistantText.slice(0, 500),
  };
}
