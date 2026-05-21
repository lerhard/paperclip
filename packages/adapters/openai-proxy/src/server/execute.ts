import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import type { OpenAiProxyConfig } from "../index.js";
import { buildTools, buildToolSchemas, findTool } from "./tools.js";

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

const DEFAULT_SYSTEM_PROMPT = `You are a Paperclip AI agent. Your job is to complete the assigned issue by any means necessary.

Workflow:
1. Analyze the issue context and determine what needs to be done.
2. Use available tools (shell commands, file reads/writes, search, paperclip_api) to investigate and make progress.
3. When you finish, set status to done and provide a summary of what you accomplished.
4. If you get stuck, add a comment explaining the blocker and set status to blocked.

Rules:
- Always prefer making changes over just describing them.
- Read files before editing them.
- Run shell commands to verify your changes work.
- Use paperclip_api to update issue status and add comments.
- End with a clear summary. Status: done + summary.`;
const TURN_DELAY_MS = 800;
const DEFAULT_MAX_TURNS = 50;
const DEFAULT_MAX_CONTEXT = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function emit(
  onLog: AdapterExecutionContext["onLog"],
  entry: Record<string, unknown>,
): void {
  if (onLog) {
    onLog("stdout", JSON.stringify(entry) + "\n");
  }
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? parseFloat(value) : NaN;
  return isNaN(n) ? fallback : n;
}

function resolveApiKey(config: OpenAiProxyConfig): string {
  const key = config.apiKey || process.env.OPENAI_PROXY_API_KEY || "";
  if (!key) {
    throw new Error("apiKey is required for openai_proxy adapter. Set adapterConfig.apiKey or OPENAI_PROXY_API_KEY env var.");
  }
  return key;
}

function resolveBaseUrl(config: OpenAiProxyConfig): string {
  const url = config.baseUrl || process.env.OPENAI_PROXY_BASE_URL || "";
  if (!url) {
    throw new Error("baseUrl is required for openai_proxy adapter. Set adapterConfig.baseUrl or OPENAI_PROXY_BASE_URL env var.");
  }
  return url.replace(/\/$/, "");
}

function resolvePaperclipApiBaseUrl(context: Record<string, unknown>): string {
  const explicit = (context.paperclipApiBaseUrl as string | undefined) ?? "";
  if (explicit) return explicit.replace(/\/$/, "");
  const fromEnv = process.env.PAPERCLIP_API_URL;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.replace(/\/$/, "");
  return "http://localhost:3100";
}

// ----- Paperclip API helpers (lightweight, no external class) -----

async function checkoutIssue(apiBaseUrl: string, authToken: string, issueId: string, runId: string): Promise<void> {
  const res = await fetch(`${apiBaseUrl}/api/issues/${issueId}/checkout`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ runId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`checkout failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

async function updateIssueStatus(apiBaseUrl: string, authToken: string, issueId: string, status: string, statusReason?: string): Promise<void> {
  const res = await fetch(`${apiBaseUrl}/api/issues/${issueId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status, statusReason: statusReason ?? null }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`update status failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

async function addIssueComment(apiBaseUrl: string, authToken: string, issueId: string, body: string): Promise<void> {
  const res = await fetch(`${apiBaseUrl}/api/issues/${issueId}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`add comment failed: ${res.status} ${text.slice(0, 200)}`);
  }
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
          await opts.onLog("stderr", `[openai-proxy] Request failed (attempt ${attempt + 1}/${maxRetries + 1}), backing off ${backoff}ms...\n`);
        }
        await sleep(backoff);
        continue;
      }
      throw new Error(`All ${maxRetries + 1} attempts failed: ${lastErrText}`);
    } finally {
      clearTimeout(timer);
    }

    // 429 rate limit
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
          await opts.onLog("stderr", `[openai-proxy] Rate limited (attempt ${attempt + 1}/${maxRetries + 1}), waiting ${Math.ceil(waitMs / 1000)}s...\n`);
        }
        await sleep(waitMs + 500);
        continue;
      }
      throw new Error(`Rate limited after ${maxRetries + 1} attempts: ${lastErrText.slice(0, 200)}`);
    }

    // 5xx server error
    if (res.status >= 500 && res.status < 600) {
      lastErrText = await res.text().catch(() => `Server error ${res.status}`);
      if (attempt < maxRetries) {
        const backoff = Math.min(1000 * Math.pow(2, attempt), 30_000);
        if (opts.onLog) {
          await opts.onLog("stderr", `[openai-proxy] Server error ${res.status} (attempt ${attempt + 1}/${maxRetries + 1}), backing off ${backoff}ms...\n`);
        }
        await sleep(backoff);
        continue;
      }
      throw new Error(`Server error ${res.status} after ${maxRetries + 1} attempts: ${lastErrText.slice(0, 200)}`);
    }

    // 400 context length
    if (res.status === 400) {
      const text = await res.text();
      const isContextLength = /maximum context length|context length is|too many tokens/i.test(text);
      if (!isContextLength) {
        throw new Error(`OpenAI Proxy API error 400: ${text.slice(0, 500)}`);
      }
      // Try truncating messages if body has them
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
              await opts.onLog("stderr", `[openai-proxy] Context too long, truncating messages (${parsed.messages.length} kept)...\n`);
            }
            continue;
          }
        } catch { /* ignore parse errors */ }
      }
      throw new Error(`OpenAI Proxy API error 400 (context length): ${text.slice(0, 500)}`);
    }

    // Any other non-2xx: don't retry
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI Proxy API error ${res.status}: ${text.slice(0, 500)}`);
    }

    return res;
  }

  throw new Error(`All ${maxRetries + 1} attempts failed: ${lastErrText}`);
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, context, onLog, agent, runId, authToken } = ctx;
  const proxyConfig = (config ?? {}) as unknown as OpenAiProxyConfig;

  const apiKey = resolveApiKey(proxyConfig);
  const baseUrl = resolveBaseUrl(proxyConfig);
  const model = asString(proxyConfig.model, "");
  if (!model) {
    throw new Error("model is required for openai_proxy adapter.");
  }

  const temperature = asNumber(proxyConfig.temperature, 0.7);
  const maxTokens = asNumber(proxyConfig.maxTokens, 2048);
  const systemPrompt = asString(proxyConfig.systemPrompt, DEFAULT_SYSTEM_PROMPT);
  const timeoutSec = Math.max(30, asNumber(proxyConfig.timeoutSec, 120));
  const maxTurns = asNumber((config as any).maxTurns, DEFAULT_MAX_TURNS);

  const chatEndpoint = `${baseUrl}/chat/completions`;
  const paperclipApiBaseUrl = resolvePaperclipApiBaseUrl(context);
  const hasAuthToken = typeof authToken === "string" && authToken.length > 0;

  // Only build Paperclip tools if we have an auth token; otherwise the model
  // can still respond textually but cannot mutate state.
  const tools = hasAuthToken
    ? buildTools({
        agentId: agent.id,
        companyId: agent.companyId,
        currentIssueId: (context.issueId as string | null | undefined) ?? null,
        apiBaseUrl: paperclipApiBaseUrl,
        apiKey: authToken,
        runId,
      })
    : [];
  const toolSchemas = buildToolSchemas(tools);

  const currentIssueId = (context.issueId as string | null | undefined) ?? null;
  const structuredWakePrompt = renderPaperclipWakePrompt(ctx);

  const ts = () => new Date().toISOString();

  emit(onLog, {
    kind: "init",
    ts: ts(),
    model,
    sessionId: runId,
  });

  if (!hasAuthToken) {
    emit(onLog, {
      kind: "stderr",
      ts: ts(),
      text: "[openai-proxy] No authToken — paperclip_api tools disabled. Agent can only generate text.",
    });
  }

  let messages: ChatMessage[] = [
    {
      role: "system",
      content: currentIssueId
        ? `${systemPrompt}\n\nYou are working on issue ${currentIssueId}. Use paperclip_api to update status and add comments.\n\n${structuredWakePrompt}`
        : `${systemPrompt}\n\n${structuredWakePrompt}`,
    },
  ];

  const MAX_CONTEXT = asNumber((config as any).maxContextMessages, DEFAULT_MAX_CONTEXT);

  // ----- issue checkout (same pattern as OpenRouter) -----
  let issueLocked = false;
  if (hasAuthToken && currentIssueId) {
    try {
      await checkoutIssue(paperclipApiBaseUrl, authToken, currentIssueId, runId);
      issueLocked = true;
      emit(onLog, { kind: "system", ts: ts(), text: `[openai-proxy] Checked out issue ${currentIssueId}` });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      emit(onLog, { kind: "stderr", ts: ts(), text: `[openai-proxy] checkout failed: ${reason}. Continuing — heartbeat may have pre-locked.` });
      issueLocked = true; // optimistic: let writes fail at the API level if truly locked
    }

    // Mark in_progress
    if (issueLocked) {
      try {
        await updateIssueStatus(paperclipApiBaseUrl, authToken, currentIssueId, "in_progress");
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        emit(onLog, { kind: "stderr", ts: ts(), text: `[openai-proxy] could not set in_progress: ${reason}` });
      }
    }
  }

  let finalText = "";
  let stoppedReason: "completed" | "max_turns" | "error" | "repeat_loop" = "completed";
  let runError: { message: string; code: string } | null = null;
  let turn = 0;
  let totalUsage = { inputTokens: 0, outputTokens: 0 };

  // Loop-detection: same tool + same args 3x in a row = break
  const recentCalls: string[] = [];
  const REPEAT_THRESHOLD = 3;

  // Tool result cache: avoid re-executing identical calls across turns
  const toolResultCache = new Map<string, { content: string; isError: boolean }>();
  // Hard cap: if messages grow beyond this, aggressively truncate to prevent memory explosion
  const HARD_MESSAGE_CAP = 80;

  try {
    while (turn < maxTurns) {
      turn++;
      if (turn > 1) await sleep(TURN_DELAY_MS);

      emit(onLog, {
        kind: "system",
        ts: ts(),
        text: `[openai-proxy] Turn ${turn}/${maxTurns} — ${toolSchemas.length} tools available`,
      });

      // Aggressive truncation to prevent memory leak / context explosion
      let messagesToSend = messages;
      const effectiveMax = Math.min(MAX_CONTEXT, Math.floor(HARD_MESSAGE_CAP / 2));
      if (messages.length > effectiveMax + 1) {
        const systemMsg = messages[0];
        let startIndex = messages.length - effectiveMax;
        while (startIndex > 1 && messages[startIndex].role === "tool") {
          startIndex--;
        }
        messagesToSend = [systemMsg, ...messages.slice(startIndex)];
        if (turn === 1 || turn % 5 === 0) {
          emit(onLog, { kind: "system", ts: ts(), text: `[openai-proxy] Context truncated: ${messages.length} → ${messagesToSend.length} messages` });
        }
      }
      // Also enforce absolute hard cap on the live messages array
      if (messages.length > HARD_MESSAGE_CAP) {
        const systemMsg = messages[0];
        messages = [systemMsg, ...messages.slice(-Math.floor(HARD_MESSAGE_CAP / 2))];
      }

      // Periodic cache cleanup to prevent memory growth over long runs
      if (turn % 10 === 0) {
        const cacheSize = toolResultCache.size;
        if (cacheSize > 20) {
          toolResultCache.clear();
          if (onLog) emit(onLog, { kind: "system", ts: ts(), text: `[openai-proxy] Cleared tool cache (${cacheSize} entries) to free memory` });
        }
        if (recentCalls.length > REPEAT_THRESHOLD * 2) {
          recentCalls.splice(0, recentCalls.length - REPEAT_THRESHOLD);
        }
      }

      const body: Record<string, unknown> = {
        model,
        messages: messagesToSend,
        max_tokens: maxTokens,
        temperature,
      };
      if (toolSchemas.length > 0) {
        body.tools = toolSchemas;
        body.tool_choice = "auto";
      }

      const res = await fetchWithRetry(chatEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }, { maxRetries: 3, timeoutMs: timeoutSec * 1000, onLog });

      const data = (await res.json()) as ChatCompletionResponse;
      const choice = data.choices?.[0];
      if (!choice) {
        throw new Error("No choices returned from OpenAI Proxy API");
      }

      if (data.usage) {
        totalUsage.inputTokens += data.usage.prompt_tokens ?? 0;
        totalUsage.outputTokens += data.usage.completion_tokens ?? 0;
      }

      const msg = choice.message;
      finalText = msg.content ?? "";

      // Emit reasoning/thinking if present (some proxies expose it in content or a reasoning field)
      const reasoning = (msg as any).reasoning || "";
      if (reasoning) {
        emit(onLog, { kind: "thinking", ts: ts(), text: reasoning, delta: false });
      }

      emit(onLog, {
        kind: "assistant",
        ts: ts(),
        text: msg.content ?? "",
      });

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // OpenAI spec: content should be null (or empty) when tool_calls are present
        messages.push({
          role: "assistant",
          content: msg.content || null,
          tool_calls: msg.tool_calls,
        });

        for (const tc of msg.tool_calls) {
          emit(onLog, {
            kind: "tool_call",
            ts: ts(),
            name: tc.function.name,
            input: tc.function.arguments,
            toolUseId: tc.id,
          });

          const tool = findTool(tools, tc.function.name);
          let result: { content: string; isError: boolean };
          const cacheKey = `${tc.function.name}::${tc.function.arguments}`;
          const cached = toolResultCache.get(cacheKey);

          if (cached) {
            result = cached;
            emit(onLog, { kind: "system", ts: ts(), text: `[openai-proxy] Cache hit: ${tc.function.name}` });
          } else if (!tool) {
            result = { content: JSON.stringify({ error: `Unknown tool: ${tc.function.name}` }), isError: true };
          } else {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              result = { content: JSON.stringify({ error: "Invalid tool arguments JSON" }), isError: true };
              messages.push({ role: "tool", content: result.content, tool_call_id: tc.id });
              emit(onLog, {
                kind: "tool_result",
                ts: ts(),
                toolUseId: tc.id,
                toolName: tc.function.name,
                content: result.content,
                isError: result.isError,
              });
              continue;
            }
            result = await tool.execute(args);
            toolResultCache.set(cacheKey, result);
          }

          messages.push({ role: "tool", content: result.content, tool_call_id: tc.id });
          emit(onLog, {
            kind: "tool_result",
            ts: ts(),
            toolUseId: tc.id,
            toolName: tc.function.name,
            content: result.content,
            isError: result.isError,
          });

          // Track repeat calls
          recentCalls.push(cacheKey);
          if (recentCalls.length > REPEAT_THRESHOLD) recentCalls.shift();
          if (recentCalls.length === REPEAT_THRESHOLD && recentCalls.every((s) => s === cacheKey)) {
            emit(onLog, {
              kind: "stderr",
              ts: ts(),
              text: `[openai-proxy] Tool "${tc.function.name}" called ${REPEAT_THRESHOLD}x with identical args — breaking loop.`,
            });
            runError = {
              message: `Tool "${tc.function.name}" was called ${REPEAT_THRESHOLD} times in a row with identical arguments.`,
              code: "tool_repeat_loop",
            };
            stoppedReason = "repeat_loop";
            break;
          }
        }
        if (stoppedReason === "repeat_loop") break;
        continue;
      }

      messages.push({ role: "assistant", content: msg.content ?? "" });
      break;
    }

    if (turn >= maxTurns && stoppedReason !== "repeat_loop") {
      stoppedReason = "max_turns";
      finalText += "\n\n[Stopped after max turns]";
    }
  } catch (err) {
    stoppedReason = "error";
    const reason = err instanceof Error ? err.message : String(err);
    finalText = reason;
    runError = { message: reason, code: "proxy_error" };
    emit(onLog, {
      kind: "stderr",
      ts: ts(),
      text: `[openai-proxy] Error: ${reason}`,
    });
  }

  // ----- post-loop: comment + status -----
  if (hasAuthToken && currentIssueId) {
    // Post final text as comment
    if (finalText.trim().length > 0) {
      try {
        await addIssueComment(paperclipApiBaseUrl, authToken, currentIssueId, finalText);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        emit(onLog, { kind: "stderr", ts: ts(), text: `[openai-proxy] could not post final comment: ${reason}` });
      }
    }

    // Update issue status
    let nextStatus: string | null = null;
    let statusReason: string | null = null;
    if (stoppedReason === "completed") {
      nextStatus = "done";
    } else if (stoppedReason === "max_turns") {
      nextStatus = "blocked";
      statusReason = `Hit max_turns (${maxTurns}) without completing`;
    } else if (stoppedReason === "repeat_loop" && runError) {
      nextStatus = "blocked";
      statusReason = runError.message;
    } else if (stoppedReason === "error" && runError) {
      nextStatus = "blocked";
      statusReason = runError.message;
    }
    if (nextStatus) {
      try {
        await updateIssueStatus(paperclipApiBaseUrl, authToken, currentIssueId, nextStatus, statusReason ?? undefined);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        emit(onLog, { kind: "stderr", ts: ts(), text: `[openai-proxy] could not update final status: ${reason}` });
      }
    }
  }

  emit(onLog, {
    kind: "result",
    ts: ts(),
    text: finalText,
    inputTokens: totalUsage.inputTokens,
    outputTokens: totalUsage.outputTokens,
    cachedTokens: 0,
    costUsd: 0,
    subtype: stoppedReason,
    isError: stoppedReason === "error",
    errors: runError ? [runError.message] : [],
  });

  return {
    exitCode: stoppedReason === "error" ? 1 : 0,
    signal: null,
    timedOut: false,
    errorMessage: runError ? runError.message : null,
    errorCode: runError ? runError.code : null,
    usage: totalUsage,
    model,
    provider: "openai_proxy",
    biller: "openai_proxy",
    billingType: "api",
    sessionParams: { lastGenerationId: runId },
  };
}
