import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import fs from "node:fs/promises";
import {
  renderPaperclipWakePrompt,
  parseObject,
  renderTemplate,
  joinPromptSections,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { DEEPSEEK_CHAT_ENDPOINT, type DeepSeekConfig } from "../index.js";
import { buildTools, buildToolSchemas, findTool } from "./tools.js";
import { compressToolResult } from "./compression.js";

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
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

const DEFAULT_SYSTEM_PROMPT = "Exec tools only. End status=done.";
const TURN_DELAY_MS = 1200;
const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_CONTEXT = 10;
const HARD_MESSAGE_CAP = 80;

const TRANSIENT_UPSTREAM_RE =
  /(?:rate[-\s]?limit(?:ed)?|rate_limit_error|too\s+many\s+requests|\b429\b|overloaded(?:_error)?|server\s+overloaded|service\s+unavailable|\b502\b|\b503\b|\b529\b|provider\s+returned\s+error|high\s+demand|try\s+again\s+later|temporarily\s+unavailable|throttl(?:ed|ing)|throttlingexception|servicequotaexceededexception|out\s+of\s+extra\s+usage|extra\s+usage\b|usage\s+limit\s+reached|usage\s+cap\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached)/i;

const RETRY_NOT_BEFORE_RE =
  /(?:resets?|try\s+again|retry)\s+(?:at\s+)?([\d]{1,2}[:\d]{0,2}\s*(?:am|pm)|in\s+(\d+)\s*(minute|hour|second)s?|(?:after|in)\s+([\d]+)\s*(?:minute|hour|second)s?)/i;

const API_STDERR_NOISE_RE =
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+(?:DEBUG|INFO)\s+.*$/i;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

function emit(
  onLog: AdapterExecutionContext["onLog"],
  entry: Record<string, unknown>,
): void {
  if (onLog) {
    onLog("stdout", JSON.stringify(entry) + "\n");
  }
}

function resolveApiKey(config: DeepSeekConfig): string {
  const key = config.apiKey || process.env.DEEPSEEK_API_KEY || "";
  if (!key) {
    throw new Error(
      "DeepSeek API key not found. Set adapterConfig.apiKey or DEEPSEEK_API_KEY env var.",
    );
  }
  return key;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? parseFloat(value) : NaN;
  return isNaN(n) ? fallback : n;
}

function resolvePaperclipApiBaseUrl(context: Record<string, unknown>): string {
  const explicit = (context.paperclipApiBaseUrl as string | undefined) ?? "";
  if (explicit) return explicit.replace(/\/$/, "");
  const fromEnv = process.env.PAPERCLIP_API_URL;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.replace(/\/$/, "");
  return "http://localhost:3100";
}

// ----- Paperclip API helpers -----

async function paperclipFetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { maxRetries?: number; label: string; onLog?: AdapterExecutionContext["onLog"] },
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;
  let lastErr = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      const text = await res.text().catch(() => "");
      lastErr = `${res.status}: ${text.slice(0, 200)}`;
      if (res.status >= 500 || res.status === 429) {
        if (attempt < maxRetries) {
          const backoff = Math.min(1000 * Math.pow(2, attempt), 15000);
          if (opts.onLog) {
            opts.onLog("stderr", `[deepseek] ${opts.label} failed (${lastErr}), retrying in ${backoff}ms (attempt ${attempt + 1}/${maxRetries + 1})...\n`);
          }
          await sleep(backoff);
          continue;
        }
      }
      throw new Error(lastErr);
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries) {
        const backoff = Math.min(1000 * Math.pow(2, attempt), 15000);
        if (opts.onLog) {
          opts.onLog("stderr", `[deepseek] ${opts.label} error (${lastErr}), retrying in ${backoff}ms (attempt ${attempt + 1}/${maxRetries + 1})...\n`);
        }
        await sleep(backoff);
        continue;
      }
      throw new Error(`All ${maxRetries + 1} attempts failed for ${opts.label}: ${lastErr}`);
    }
  }
  throw new Error(`All ${maxRetries + 1} attempts failed for ${opts.label}: ${lastErr}`);
}

async function checkoutIssue(apiBaseUrl: string, authToken: string, issueId: string, agentId: string, onLog?: AdapterExecutionContext["onLog"]): Promise<void> {
  const res = await paperclipFetchWithRetry(
    `${apiBaseUrl}/api/issues/${issueId}/checkout`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ agentId, expectedStatuses: ["backlog", "todo", "in_progress", "in_review", "blocked"] }),
    },
    { label: "checkoutIssue", onLog },
  );
}

async function updateIssueStatus(apiBaseUrl: string, authToken: string, issueId: string, status: string, statusReason?: string, onLog?: AdapterExecutionContext["onLog"]): Promise<void> {
  await paperclipFetchWithRetry(
    `${apiBaseUrl}/api/issues/${issueId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status, statusReason: statusReason ?? null }),
    },
    { label: "updateIssueStatus", onLog },
  );
}

async function addIssueComment(apiBaseUrl: string, authToken: string, issueId: string, body: string, onLog?: AdapterExecutionContext["onLog"]): Promise<void> {
  await paperclipFetchWithRetry(
    `${apiBaseUrl}/api/issues/${issueId}/comments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    },
    { label: "addIssueComment", onLog },
  );
}

// ----- retry helper -----

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { maxRetries?: number; timeoutMs?: number; onLog?: AdapterExecutionContext["onLog"] },
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  let lastErrText = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      lastErrText = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries) {
        const backoff = Math.min(1000 * Math.pow(2, attempt), 30_000);
        if (opts.onLog) {
          await opts.onLog("stderr", `[deepseek] Request failed (attempt ${attempt + 1}/${maxRetries + 1}), backing off ${backoff}ms...\n`);
        }
        await sleep(backoff);
        continue;
      }
      throw new Error(`All ${maxRetries + 1} attempts failed: ${lastErrText}`);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      lastErrText = await res.text().catch(() => "Rate limited");
      const resetHeader = res.headers.get("x-ratelimit-reset");
      let waitMs = 2000;
      if (resetHeader) {
        const ts = parseInt(resetHeader, 10);
        if (!isNaN(ts)) waitMs = Math.max(0, ts - Date.now());
      }
      if (attempt < maxRetries) {
        if (opts.onLog) {
          await opts.onLog("stderr", `[deepseek] Rate limited (attempt ${attempt + 1}/${maxRetries + 1}), waiting ${Math.ceil(waitMs / 1000)}s...\n`);
        }
        await sleep(waitMs + 500);
        continue;
      }
      throw new Error(`Rate limited after ${maxRetries + 1} attempts: ${lastErrText.slice(0, 200)}`);
    }

    if (res.status >= 500 && res.status < 600) {
      lastErrText = await res.text().catch(() => `Server error ${res.status}`);
      if (attempt < maxRetries) {
        const backoff = Math.min(1000 * Math.pow(2, attempt), 30_000);
        if (opts.onLog) {
          await opts.onLog("stderr", `[deepseek] Server error ${res.status} (attempt ${attempt + 1}/${maxRetries + 1}), backing off ${backoff}ms...\n`);
        }
        await sleep(backoff);
        continue;
      }
      throw new Error(`Server error ${res.status} after ${maxRetries + 1} attempts: ${lastErrText.slice(0, 200)}`);
    }

    if (res.status === 400) {
      const text = await res.text();
      const isContextLength = /maximum context length|context length is|too many tokens/i.test(text);
      if (!isContextLength) {
        throw new Error(`DeepSeek API error 400: ${text.slice(0, 500)}`);
      }
      if (attempt < maxRetries && init.body) {
        try {
          const parsed = JSON.parse(init.body as string);
          if (Array.isArray(parsed.messages) && parsed.messages.length > 3) {
            const keep = Math.max(2, Math.floor(parsed.messages.length / 2));
            const systemMsg = parsed.messages[0];
            const recent = parsed.messages.slice(-keep);
            parsed.messages = [systemMsg, ...recent];
            init.body = JSON.stringify(parsed);
            if (opts.onLog) {
              await opts.onLog("stderr", `[deepseek] Context too long, truncating messages (${parsed.messages.length} kept)...\n`);
            }
            continue;
          }
        } catch { /* ignore parse errors */ }
      }
      throw new Error(`DeepSeek API error 400 (context length): ${text.slice(0, 500)}`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DeepSeek API error ${res.status}: ${text.slice(0, 500)}`);
    }

    return res;
  }

  throw new Error(`All ${maxRetries + 1} attempts failed: ${lastErrText}`);
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, context, onLog, onMeta, agent, runId, authToken } = ctx;
  const dsConfig: DeepSeekConfig = (config as Record<string, unknown>) || {};

  // Session validation: detect provider change or invalid session
  const previousSessionParams = ((context.runtime as any)?.sessionParams as Record<string, unknown> | undefined) ?? {};
  const previousProvider = previousSessionParams.provider as string | undefined;
  const currentProvider = "deepseek";
  const providerChanged = previousProvider && previousProvider !== currentProvider;
  
  if (providerChanged) {
    emit(onLog, { kind: "stderr", ts: new Date().toISOString(), text: `[deepseek] Provider changed from ${previousProvider} to ${currentProvider}. Creating new session.` });
  }

  const apiKey = resolveApiKey(dsConfig);
  const model = asString(dsConfig.model, "deepseek-chat");
  const temperature = asNumber(dsConfig.temperature, 0.7);
  const maxTokens = asNumber(dsConfig.maxTokens, 2048);
  const timeoutSec = asNumber(dsConfig.timeoutSec, 120);
  const maxTurns = asNumber((config as any).maxTurns, DEFAULT_MAX_TURNS);
  const maxContextMessages = asNumber((config as any).maxContextMessages, DEFAULT_MAX_CONTEXT);

  const paperclipApiBaseUrl = resolvePaperclipApiBaseUrl(context);
  const hasAuthToken = typeof authToken === "string" && authToken.length > 0;
  const currentIssueId =
    typeof context.issueId === "string" && context.issueId.trim().length > 0
      ? context.issueId.trim()
      : null;

  // Prompt template system (mirrors claude-local / codex-local)
  const promptTemplate = asString((config as any).promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const templateData: Record<string, unknown> = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    issueId: currentIssueId ?? "",
    issueTitle: typeof context.issueTitle === "string" ? context.issueTitle : "",
    model,
  };
  let renderedSystemPrompt = renderTemplate(promptTemplate, templateData);

  // If instructionsFilePath is set, read the file and use it as the base.
  const instructionsFilePath = (config as unknown as Record<string, unknown>).instructionsFilePath;
  if (typeof instructionsFilePath === "string" && instructionsFilePath.trim().length > 0) {
    try {
      const fileContent = await fs.readFile(instructionsFilePath.trim(), "utf8");
      if (fileContent.trim().length > 0) {
        renderedSystemPrompt = fileContent.trim();
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      emit(onLog, { kind: "stderr", ts: new Date().toISOString(), text: `[deepseek] could not read instructionsFilePath ${instructionsFilePath}: ${reason}. Falling back to promptTemplate.` });
    }
  }

  // Compression config (mirrors openrouter)
  const compressToolResults = (config as any).compressToolResults === true;
  const useRTK = (config as any).useRTK === true;
  const useCaveman = (config as any).useCaveman === true;

  const tools = hasAuthToken
    ? buildTools({
        agentId: agent.id,
        companyId: agent.companyId,
        currentIssueId,
        apiBaseUrl: paperclipApiBaseUrl,
        apiKey: authToken,
        runId,
      })
    : [];

  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: false });
  const userPrompt = wakePrompt.length > 0 ? wakePrompt : "Continue your work.";

  let messages: ChatMessage[] = [
    { role: "system", content: renderedSystemPrompt },
    { role: "user", content: userPrompt },
  ];

  if (onMeta) {
    await onMeta({
      adapterType: "deepseek_local",
      command: model,
      prompt: `${renderedSystemPrompt}\n\n${userPrompt}`,
      promptMetrics: {
        promptChars: renderedSystemPrompt.length + userPrompt.length,
        maxTurns,
        toolsCount: tools.length,
      },
      context: { model },
    });
  }

  const ts = () => new Date().toISOString();

  emit(onLog, { kind: "init", ts: ts(), model, sessionId: runId });

  if (!hasAuthToken) {
    emit(onLog, { kind: "stderr", ts: ts(), text: "[deepseek] No authToken — paperclip_api tools disabled. Agent can only generate text." });
  }

  // ----- issue checkout -----
  let issueLocked = false;
  if (hasAuthToken && currentIssueId) {
    try {
      await checkoutIssue(paperclipApiBaseUrl, authToken, currentIssueId, agent.id, onLog);
      issueLocked = true;
      emit(onLog, { kind: "system", ts: ts(), text: `[deepseek] Checked out issue ${currentIssueId}` });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const isConflict = reason.includes("409") || reason.includes("checked out by another");
      if (isConflict) {
        emit(onLog, { kind: "stderr", ts: ts(), text: `[deepseek] checkout conflict: ${reason}. Issue is already assigned to another agent. Stopping.` });
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: `Issue ${currentIssueId} is already checked out by another agent. Cannot proceed.`,
          errorCode: "checkout_conflict",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      emit(onLog, { kind: "stderr", ts: ts(), text: `[deepseek] checkout failed: ${reason}. Continuing — heartbeat may have pre-locked.` });
      issueLocked = true;
    }

    if (issueLocked) {
      try {
        await updateIssueStatus(paperclipApiBaseUrl, authToken, currentIssueId, "in_progress", undefined, onLog);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        emit(onLog, { kind: "stderr", ts: ts(), text: `[deepseek] could not set in_progress: ${reason}` });
      }
    }
  }

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedInputTokens = 0;
  
  // Session management: use runId as stable sessionId
  const sessionId = runId;
  let turnCount = 0;
  let stoppedReason: "completed" | "max_turns" | "error" | "repeat_loop" = "max_turns";
  let runError: { message: string; code: string } | null = null;
  const toolResultCache = new Map<string, { content: string; isError: boolean }>();
  // Track whether the model already called update_issue_status during this run
  let modelUpdatedIssueStatus = false;
  const recentCalls: string[] = [];
  const REPEAT_THRESHOLD = 3;
  // Text-repetition detection: catch content-level loops where the model
  // repeats the same text response without making any tool calls.
  const recentTexts: string[] = [];
  const TEXT_REPEAT_THRESHOLD = 3;
  // Track how many consecutive text-only turns (no tool calls) have occurred.
  let consecutiveTextOnlyTurns = 0;
  const MAX_TEXT_ONLY_TURNS = 3;

  try {
    while (turnCount < maxTurns) {
      turnCount++;
      if (turnCount > 1) await sleep(TURN_DELAY_MS);

      emit(onLog, { kind: "system", ts: ts(), text: `[deepseek] Turn ${turnCount}/${maxTurns} — ${tools.length} tools available` });

      // Truncate + enforce hard cap
      let messagesToSend = messages;
      const effectiveMax = Math.min(maxContextMessages, Math.floor(HARD_MESSAGE_CAP / 2));
      if (messages.length > effectiveMax + 1) {
        const systemMsg = messages[0];
        let startIndex = messages.length - effectiveMax;
        while (startIndex > 1 && messages[startIndex].role === "tool") startIndex--;
        let slicedMessages = messages.slice(startIndex);

        // Remove orphaned tool messages whose tool_call_id has no matching assistant
        const availableToolCallIds = new Set<string>();
        for (const m of slicedMessages) {
          if (m.role === "assistant" && m.tool_calls) {
            for (const tc of m.tool_calls) availableToolCallIds.add(tc.id);
          }
        }
        slicedMessages = slicedMessages.filter(m => {
          if (m.role === "tool" && m.tool_call_id) {
            return availableToolCallIds.has(m.tool_call_id);
          }
          return true;
        });

        messagesToSend = [systemMsg, ...slicedMessages];
        if (turnCount === 1 || turnCount % 5 === 0) {
          emit(onLog, { kind: "system", ts: ts(), text: `[deepseek] Context truncated: ${messages.length} → ${messagesToSend.length} messages` });
        }
      }
      if (messages.length > HARD_MESSAGE_CAP) {
        const systemMsg = messages[0];
        messages = [systemMsg, ...messages.slice(-Math.floor(HARD_MESSAGE_CAP / 2))];
      }

      // Clean empty messages (never filter tool)
      const cleanMessages = messagesToSend.filter((m) => {
        if (m.role === "system") return true;
        if (m.role === "tool") return true;
        if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) return true;
        if (typeof m.content === "string" && m.content.trim().length > 0) return true;
        if (m.content === null && m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) return true;
        return false;
      });

      // Dedup consecutive same-role (never merge tool)
      const dedupedMessages: ChatMessage[] = [];
      for (const m of cleanMessages) {
        const last = dedupedMessages[dedupedMessages.length - 1];
        if (last && last.role === m.role && m.role !== "tool") {
          if (m.role === "assistant" && m.tool_calls) {
            last.tool_calls = [...(last.tool_calls ?? []), ...m.tool_calls];
            if (m.content) last.content = (last.content ?? "") + "\n" + m.content;
          } else if (typeof m.content === "string") {
            last.content = (typeof last.content === "string" ? last.content : "") + "\n" + m.content;
          }
          continue;
        }
        dedupedMessages.push({ ...m });
      }

      const body: Record<string, unknown> = {
        model,
        messages: dedupedMessages,
        temperature,
        max_tokens: maxTokens,
      };
      if (model === "deepseek-chat" || model.includes("deepseek-v3")) {
        body.ephemeral = true;
      }
      if (tools.length > 0) {
        body.tools = buildToolSchemas(tools);
        body.tool_choice = "auto";
      }

      const res = await fetchWithRetry(DEEPSEEK_CHAT_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }, { maxRetries: 3, timeoutMs: timeoutSec * 1000, onLog });

      const data = (await res.json()) as ChatCompletionResponse;

      // API can return { error: { message, type, code } } even with HTTP 200
      if ((data as any).error) {
        const apiErr = (data as any).error;
        const errMsg = typeof apiErr === "object" ? (apiErr.message || JSON.stringify(apiErr)) : String(apiErr);
        throw new Error(`DeepSeek API error: ${errMsg}`);
      }

      const choice = data.choices?.[0];
      const message = choice?.message;
      const finishReason = choice?.finish_reason;

      if (!choice) {
        throw new Error("No choices returned from DeepSeek API");
      }

      if (data.usage) {
        totalInputTokens += data.usage.prompt_tokens ?? 0;
        totalOutputTokens += data.usage.completion_tokens ?? 0;
      }

      // Preserve reasoning in context
      const reasoningContent = message?.reasoning_content ?? "";
      const assistantContent = message?.content || "";
      const contextContent = reasoningContent && reasoningContent.trim().length > 0
        ? `${reasoningContent.trim()}\n\n${assistantContent}`
        : assistantContent;

      const cleanedContent = (message?.content || "").replace(/\[reasoning unavailable\]/gi, "").trim();

      // Emit thinking
      if (reasoningContent && reasoningContent.trim().length > 0) {
        emit(onLog, { kind: "thinking", ts: ts(), text: reasoningContent.trim(), delta: false });
      }

      emit(onLog, { kind: "assistant", ts: ts(), text: cleanedContent });

      // Handle finish_reason: "length" means the response was truncated by max_tokens.
      if (finishReason === "length" && !(message?.tool_calls && message.tool_calls.length > 0)) {
        emit(onLog, { kind: "stderr", ts: ts(), text: "[deepseek] Response truncated (finish_reason=length). Nudging model to continue..." });
        messages.push({ role: "assistant", content: contextContent || "" });
        messages.push({
          role: "user",
          content: "SYSTEM: Your previous response was cut off because it exceeded the maximum token limit. Please continue from where you stopped. If you were about to call a tool, please call it now.",
        });
        continue;
      }

      if (message?.tool_calls && message.tool_calls.length > 0) {
        // Reset text-only counter when model makes tool calls
        consecutiveTextOnlyTurns = 0;

        messages.push({
          role: "assistant",
          content: contextContent || null,
          tool_calls: message.tool_calls,
        });

        for (const toolCall of message.tool_calls) {
          const toolName = toolCall.function.name;
          emit(onLog, {
            kind: "tool_call",
            ts: ts(),
            name: toolName,
            input: toolCall.function.arguments,
            toolUseId: toolCall.id,
          });

          let args: Record<string, unknown>;
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            const errText = JSON.stringify({ error: "Invalid tool arguments JSON" });
            messages.push({ role: "tool", content: errText, tool_call_id: toolCall.id });
            emit(onLog, {
              kind: "tool_result",
              ts: ts(),
              toolUseId: toolCall.id,
              toolName,
              content: errText,
              isError: true,
            });
            continue;
          }

          const cacheKey = `${toolName}::${JSON.stringify(args)}`;
          const cached = toolResultCache.get(cacheKey);
          let result: { content: string; isError: boolean };

          if (cached) {
            result = cached;
            emit(onLog, { kind: "system", ts: ts(), text: `[deepseek] Cache hit: ${toolName}` });
          } else {
            const tool = findTool(tools, toolName);
            if (!tool) {
              result = { content: JSON.stringify({ error: `Unknown tool: ${toolName}` }), isError: true };
            } else {
              result = await tool.execute(args);
              toolResultCache.set(cacheKey, result);
            }
          }

          // Apply compression if enabled (mirrors openrouter)
          let compressedContent = result.content;
          if (compressToolResults && result.content.length > 100) {
            try {
              const parsed = JSON.parse(result.content);
              compressedContent = compressToolResult(parsed, { useTOON: true, useRTK, useCaveman: false, useVarman: true });
            } catch {
              compressedContent = compressToolResult(result.content, { useTOON: false, useRTK: false, useCaveman, useVarman: !useCaveman });
            }
            const saved = result.content.length - compressedContent.length;
            if (saved > 0) {
              const pct = Math.round((saved / result.content.length) * 100);
              emit(onLog, { kind: "system", ts: ts(), text: `[deepseek] Compressed ${toolName} result: ${result.content.length.toLocaleString()} → ${compressedContent.length.toLocaleString()} bytes (${pct}% saved)` });
            }
          }

          messages.push({ role: "tool", content: compressedContent, tool_call_id: toolCall.id });
          emit(onLog, {
            kind: "tool_result",
            ts: ts(),
            toolUseId: toolCall.id,
            toolName,
            content: compressedContent,
            isError: result.isError,
          });

          // Invalidate cached read results when a write operation occurs on the same path
          const writePaths = ["write_file", "edit_file", "move_file", "delete_file"];
          if (writePaths.includes(toolName)) {
            const writePath = args.path as string | undefined;
            if (writePath) {
              for (const [key] of toolResultCache) {
                if (key.includes(writePath)) {
                  toolResultCache.delete(key);
                }
              }
            }
          }

          // Track if model explicitly updated issue status via tool
          if (toolName === "paperclip_api" && args.action === "update_issue_status" && !result.isError) {
            modelUpdatedIssueStatus = true;
          }

          // Loop detection
          recentCalls.push(cacheKey);
          if (recentCalls.length > REPEAT_THRESHOLD) recentCalls.shift();
          if (recentCalls.length === REPEAT_THRESHOLD && recentCalls.every((s) => s === cacheKey)) {
            emit(onLog, {
              kind: "stderr",
              ts: ts(),
              text: `[deepseek] Tool "${toolName}" called ${REPEAT_THRESHOLD}x with identical args — breaking loop.`,
            });
            runError = {
              message: `Tool "${toolName}" was called ${REPEAT_THRESHOLD} times in a row with identical arguments.`,
              code: "tool_repeat_loop",
            };
            stoppedReason = "repeat_loop";
            break;
          }
        }
        if (stoppedReason === "repeat_loop") break;
        continue;
      }

      // No tool calls — check if we should treat this as completion or continue.
      if (!cleanedContent) {
        // Empty response is NOT completion — model is stuck or confused.
        // Nudge it to continue instead of falsely marking done.
        emit(onLog, { kind: "stderr", ts: ts(), text: "[deepseek] WARNING: Empty response (no text, no tool calls). Nudging model to continue..." });
        messages.push({ role: "assistant", content: "" });
        messages.push({
          role: "user",
          content: "SYSTEM: You returned an empty response. Please continue working on the issue using the available tools.",
        });
        consecutiveTextOnlyTurns++;
        if (consecutiveTextOnlyTurns >= MAX_TEXT_ONLY_TURNS) {
          emit(onLog, { kind: "stderr", ts: ts(), text: `[deepseek] Model responded ${MAX_TEXT_ONLY_TURNS}x with empty/text only. Treating as error.` });
          runError = {
            message: `Model responded ${MAX_TEXT_ONLY_TURNS} times with empty or non-tool responses without completing.`,
            code: "empty_response_loop",
          };
          stoppedReason = "error";
          break;
        }
        continue;
      }

      // Detect pseudo-code tool calls (model outputs HTML/XML tags instead of structured tool_calls)
      const pseudoCodePatterns = [
        /<tool_call>/i,
        /<function=/i,
        /```\s*(?:json|tool|function)/i,
        /\[tool_call\]/i,
        /\{tool_call\}/i,
        /<\/?(tool|function|parameter|invoke)[ >]/i,
      ];
      const hasPseudoCode = pseudoCodePatterns.some(p => p.test(cleanedContent));
      if (hasPseudoCode) {
        emit(onLog, { kind: "stderr", ts: ts(), text: "[deepseek] WARNING: Model generated pseudo-code tool calls (text/XML) instead of structured tool_calls. Injecting correction..." });
        messages.push({ role: "assistant", content: contextContent || "" });
        messages.push({
          role: "user",
          content: "SYSTEM: You tried to call tools using text/XML formatting, but this adapter requires structured JSON tool_calls. Do NOT write <tool_call>, <function=...>, or markdown code blocks to invoke tools. Instead, use the tool_calls mechanism provided by the API. Please retry your action using the correct tool calling format.",
        });
        consecutiveTextOnlyTurns++;
        if (consecutiveTextOnlyTurns >= MAX_TEXT_ONLY_TURNS) {
          emit(onLog, { kind: "stderr", ts: ts(), text: `[deepseek] Model failed to use structured tool calls after ${MAX_TEXT_ONLY_TURNS} attempts. Breaking loop.` });
          runError = {
            message: `Model repeatedly generated pseudo-code tool calls instead of using the structured tool_calls API after ${MAX_TEXT_ONLY_TURNS} attempts.`,
            code: "pseudo_tool_call_loop",
          };
          stoppedReason = "error";
          break;
        }
        continue;
      }

      // Check for explicit completion signals.
      // Keep only unambiguous phrases; broad ones like "work is done" / "all done"
      // match normal analysis text and trigger false completed detection.
      const lowerText = cleanedContent.toLowerCase();
      const completionSignals = [
        /\bstatus:\s*done\b/,
        /\bstatus\s*=\s*done\b/,
        /\bnothing more to do\b/,
        /\bfinal summary\b/,
      ];
      if (completionSignals.some((p) => p.test(lowerText))) {
        messages.push({ role: "assistant", content: contextContent || "" });
        stoppedReason = "completed";
        break;
      }

      // Text-repetition loop detection
      const textSig = cleanedContent.trim().slice(0, 500);
      recentTexts.push(textSig);
      if (recentTexts.length > TEXT_REPEAT_THRESHOLD) recentTexts.shift();
      if (
        recentTexts.length === TEXT_REPEAT_THRESHOLD &&
        recentTexts.every((t) => t === textSig)
      ) {
        emit(onLog, { kind: "stderr", ts: ts(), text: `[deepseek] Model repeated the same text ${TEXT_REPEAT_THRESHOLD}x without tool calls \u2014 breaking loop.` });
        runError = {
          message: `Model repeated the same text response ${TEXT_REPEAT_THRESHOLD} times without making any tool calls. Likely stuck in a loop.`,
          code: "text_repeat_loop",
        };
        stoppedReason = "repeat_loop";
        break;
      }

      // Model responded with text but no completion signal and no tool calls.
      // Give it a few chances to self-correct by nudging it.
      consecutiveTextOnlyTurns++;
      if (consecutiveTextOnlyTurns >= MAX_TEXT_ONLY_TURNS) {
        // Model is stuck in a text-only loop — NOT completion.
        emit(onLog, { kind: "stderr", ts: ts(), text: `[deepseek] Model responded ${MAX_TEXT_ONLY_TURNS}x with text only (no tool calls, no completion signal). Treating as blocked.` });
        runError = {
          message: `Model responded ${MAX_TEXT_ONLY_TURNS} times with text only without using tools or signaling completion.`,
          code: "text_only_loop",
        };
        stoppedReason = "error";
        break;
      }

      // Nudge the model to use tools or signal completion
      messages.push({ role: "assistant", content: contextContent || "" });
      messages.push({
        role: "user",
        content: "SYSTEM: You responded with text but did not call any tools and did not signal completion (status: done). Please either use the available tools to make progress, or if you are finished, explicitly state 'status: done' with a summary.",
      });
      continue;
    }

    if (turnCount >= maxTurns && stoppedReason !== "repeat_loop") {
      stoppedReason = "max_turns";
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const cleanedReason = cleanStderr(reason);
    const isTransientErr = isTransientError(cleanedReason);

    // Session/conversation not found => retry with clean messages (mirrors claude/codex)
    const isSessionUnknown = /session.*not found|conversation.*not found|unknown.*run|run.*not found|no conversation found/i.test(cleanedReason);
    if (isSessionUnknown && !isTransientErr) {
      emit(onLog, { kind: "system", ts: ts(), text: "Session not found; cannot retry (outside loop). Treating as error." });
      stoppedReason = "error";
      runError = {
        message: `Session not found: ${cleanedReason}`,
        code: "session_not_found",
      };
    } else {
      stoppedReason = "error";
      const extractedRetry = isTransientErr ? extractRetryNotBefore(cleanedReason) : null;
      runError = {
        message: cleanedReason,
        code: isTransientErr ? "transient_upstream" : "deepseek_error",
      };
      if (isTransientErr) {
        (runError as any).errorFamily = "transient_upstream";
        (runError as any).retryNotBefore = extractedRetry ?? new Date(Date.now() + 60_000).toISOString();
      }
      emit(onLog, { kind: "stderr", ts: ts(), text: `[deepseek] Error: ${cleanedReason}` });
    }
  }

  // ----- post-loop: comment + status -----
  let finalText = "";
  if (messages.length > 0) {
    // Find the last assistant message that has actual text content
    // (tool_call assistant messages often have content: null or "")
    const assistantMessages = messages.filter(
      (m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim().length > 0
    );
    const lastAssistant = assistantMessages.pop();
    if (lastAssistant) {
      finalText = lastAssistant.content!.replace(/\[reasoning unavailable\]/gi, "").trim();
    }
  }

  if (hasAuthToken && currentIssueId) {
    if (finalText.trim().length > 0) {
      try {
        await addIssueComment(paperclipApiBaseUrl, authToken, currentIssueId, finalText, onLog);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        emit(onLog, { kind: "stderr", ts: ts(), text: `[deepseek] could not post final comment: ${reason}` });
      }
    }

    // Skip status update if the model already explicitly set it via tool
    let nextStatus: string | null = null;
    let statusReason: string | null = null;
    if (modelUpdatedIssueStatus) {
      emit(onLog, { kind: "system", ts: ts(), text: `[deepseek] Model already updated issue status via tool. Skipping post-loop status update.` });
    } else if (stoppedReason === "completed") {
      nextStatus = "done";
    } else if (stoppedReason === "max_turns") {
      emit(onLog, { kind: "system", ts: ts(), text: `[deepseek] Heartbeat ended after ${maxTurns} turns. Issue remains in_progress for next cycle.` });
    } else if (stoppedReason === "repeat_loop" && runError) {
      nextStatus = "blocked";
      statusReason = runError.message;
    } else if (stoppedReason === "error" && runError) {
      nextStatus = "blocked";
      statusReason = runError.message;
    }
    if (nextStatus) {
      try {
        await updateIssueStatus(paperclipApiBaseUrl, authToken, currentIssueId, nextStatus, statusReason ?? undefined, onLog);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        emit(onLog, { kind: "stderr", ts: ts(), text: `[deepseek] could not update final status: ${reason}` });
      }
    }
  }

  const isMaxTurns = stoppedReason === "max_turns";
  const isError = stoppedReason === "error";
  const hasTransientError = isError && (runError as any)?.errorFamily === "transient_upstream";
  const shouldClearSession = isMaxTurns || (isError && !hasTransientError);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceId = asString((workspaceContext as any).workspaceId, "");
  const workspaceRepoUrl = asString((workspaceContext as any).repoUrl, "");
  const workspaceRepoRef = asString((workspaceContext as any).repoRef, "");

  emit(onLog, {
    kind: "result",
    ts: ts(),
    text: finalText,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cachedTokens: 0,
    costUsd: 0,
    subtype: stoppedReason,
    isError,
    errors: runError ? [runError.message] : [],
  });

  return {
    exitCode: isError ? 1 : 0,
    signal: null,
    timedOut: false,
    errorMessage: runError ? runError.message : isMaxTurns ? `Hit max_turns (${maxTurns}) without completing` : null,
    errorCode: runError ? runError.code : isMaxTurns ? "max_turns_exhausted" : null,
    errorFamily: hasTransientError ? "transient_upstream" : null,
    retryNotBefore: hasTransientError ? (runError as any).retryNotBefore ?? null : null,
    resultJson: (() => {
      const base: Record<string, unknown> = {
        stopReason: isMaxTurns ? "max_turns_exhausted" : stoppedReason === "error" ? runError?.code : "completed",
        turnsCompleted: turnCount,
        finalTextLength: finalText.length,
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cachedInputTokens: totalCachedInputTokens,
        },
      };
      if (hasTransientError) {
        base.errorFamily = "transient_upstream";
        base.retryNotBefore = (runError as any)?.retryNotBefore ?? null;
      }
      if (stoppedReason === "error" && runError) {
        base.errorDetail = runError.message;
      }
      return base;
    })(),
    usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cachedInputTokens: totalCachedInputTokens },
    model,
    provider: "deepseek",
    biller: "deepseek",
    billingType: "api",
    clearSession: shouldClearSession,
    sessionId,
    sessionDisplayId: sessionId,
    sessionParams: {
      lastGenerationId: runId,
      provider: currentProvider,
      ...(workspaceId ? { workspaceId } : {}),
      ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
      ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
    },
    summary: finalText.slice(0, 500),
  };
}
