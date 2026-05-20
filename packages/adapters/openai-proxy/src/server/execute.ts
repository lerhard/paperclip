import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import type { OpenAiProxyConfig } from "../index.js";
import { buildTools, buildToolSchemas, findTool } from "./tools.js";

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
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

const DEFAULT_SYSTEM_PROMPT = "Exec tools only. End status=done.";
const TURN_DELAY_MS = 1200;
const DEFAULT_MAX_TURNS = 12;
const DEFAULT_MAX_CONTEXT = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? parseFloat(value) : NaN;
  return isNaN(n) ? fallback : n;
}

function resolveApiKey(config: OpenAiProxyConfig): string {
  const key = config.apiKey || "";
  if (!key) {
    throw new Error("apiKey is required for openai_proxy adapter.");
  }
  return key;
}

function resolveBaseUrl(config: OpenAiProxyConfig): string {
  const url = config.baseUrl || "";
  if (!url) {
    throw new Error("baseUrl is required for openai_proxy adapter.");
  }
  return url.replace(/\/$/, "");
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
  const timeoutSec = asNumber(proxyConfig.timeoutSec, 120);
  const maxTurns = asNumber((config as any).maxTurns, DEFAULT_MAX_TURNS);

  const chatEndpoint = `${baseUrl}/chat/completions`;

  const tools = buildTools({
    agentId: agent.id,
    companyId: agent.companyId,
    currentIssueId: (context.issueId as string | null | undefined) ?? null,
    apiBaseUrl: (context.paperclipApiBaseUrl as string | undefined) ?? "",
    apiKey: (authToken as string | null) ?? "",
    runId,
  });

  const toolSchemas = buildToolSchemas(tools);

  const issueId = context.issueId ?? "";
  const structuredWakePrompt = renderPaperclipWakePrompt(ctx);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: issueId
        ? `${systemPrompt}\n\nYou are working on issue ${issueId}. Use paperclip_api to update status and add comments.\n\n${structuredWakePrompt}`
        : `${systemPrompt}\n\n${structuredWakePrompt}`,
    },
  ];

  const MAX_CONTEXT = asNumber((config as any).maxContextMessages, DEFAULT_MAX_CONTEXT);

  let finalText = "";
  let stoppedReason: "completed" | "max_turns" | "error" = "completed";
  let turn = 0;

  try {
    while (turn < maxTurns) {
      turn++;
      if (turn > 1) await sleep(TURN_DELAY_MS);

      let messagesToSend = messages;
      if (MAX_CONTEXT && messages.length > MAX_CONTEXT + 1) {
        const systemMsg = messages[0];
        const recent = messages.slice(-MAX_CONTEXT);
        messagesToSend = [systemMsg, ...recent];
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

      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(), timeoutSec * 1000);

      let res: Response;
      try {
        res = await fetch(chatEndpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutTimer);
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenAI Proxy API error ${res.status}: ${text.slice(0, 500)}`);
      }

      const data = (await res.json()) as ChatCompletionResponse;
      const choice = data.choices?.[0];
      if (!choice) {
        throw new Error("No choices returned from OpenAI Proxy API");
      }

      const msg = choice.message;
      finalText = msg.content ?? "";

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        messages.push({
          role: "assistant",
          content: msg.content ?? "",
          tool_calls: msg.tool_calls,
        });

        for (const tc of msg.tool_calls) {
          const tool = findTool(tools, tc.function.name);
          let result: { content: string; isError: boolean };
          if (!tool) {
            result = { content: JSON.stringify({ error: `Unknown tool: ${tc.function.name}` }), isError: true };
          } else {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              result = { content: JSON.stringify({ error: "Invalid tool arguments JSON" }), isError: true };
              messages.push({ role: "tool", content: result.content, tool_call_id: tc.id });
              continue;
            }
            result = await tool.execute(args);
          }
          messages.push({ role: "tool", content: result.content, tool_call_id: tc.id });
        }
        continue;
      }

      messages.push({ role: "assistant", content: msg.content ?? "" });
      break;
    }

    if (turn >= maxTurns) {
      stoppedReason = "max_turns";
      finalText += "\n\n[Stopped after max turns]";
    }
  } catch (err) {
    stoppedReason = "error";
    finalText = err instanceof Error ? err.message : String(err);
    if (onLog) {
      await onLog("stderr", `[openai-proxy] Error: ${finalText}\n`);
    }
  }

  const usage = { inputTokens: 0, outputTokens: 0 };

  return {
    exitCode: stoppedReason === "error" ? 1 : 0,
    signal: null,
    timedOut: false,
    errorMessage: stoppedReason === "error" ? finalText : null,
    errorCode: stoppedReason === "error" ? "proxy_error" : null,
    usage,
    model,
    provider: "openai_proxy",
    biller: "openai_proxy",
    billingType: "api",
    sessionParams: { lastGenerationId: runId },
  };
}
