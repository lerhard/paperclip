import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { DEEPSEEK_CHAT_ENDPOINT, type DeepSeekConfig } from "../index.js";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    finish_reason: string | null;
    message: {
      role: "assistant";
      content: string | null;
      reasoning_content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

const DEFAULT_SYSTEM_PROMPT =
  "Paperclip AI agent. EXECUTE tasks using tools. No descriptions — only actions.";

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

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, context, onLog } = ctx;
  const dsConfig: DeepSeekConfig = (config as Record<string, unknown>) || {};

  const apiKey = resolveApiKey(dsConfig);
  const model = asString(dsConfig.model, "deepseek-chat");
  const temperature = asNumber(dsConfig.temperature, 0.7);
  const maxTokens = asNumber(dsConfig.maxTokens, 2048);
  const systemPrompt = asString(dsConfig.systemPrompt, DEFAULT_SYSTEM_PROMPT);
  const timeoutSec = asNumber(dsConfig.timeoutSec, 120);

  // Build prompt from wake context (already compressed by renderPaperclipWakePrompt)
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: false });
  const userPrompt = wakePrompt.length > 0 ? wakePrompt : "Continue your work.";

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  // Enable prompt caching for DeepSeek-V3 (beta feature)
  if (model === "deepseek-chat" || model.includes("deepseek-v3")) {
    body.ephemeral = true;
  }

  await onLog("stdout", `[paperclip] DeepSeek request: ${model} / ${messages.length} messages\n`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

  let response: Response;
  try {
    response = await fetch(DEEPSEEK_CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `DeepSeek request timed out after ${timeoutSec}s`,
        errorCode: "timeout",
      };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown");
    return {
      exitCode: response.status,
      signal: null,
      timedOut: false,
      errorMessage: `DeepSeek API returned ${response.status}: ${text.slice(0, 500)}`,
      errorCode: "api_error",
    };
  }

  const data = (await response.json()) as ChatCompletionResponse;

  const choice = data.choices?.[0];
  const assistantContent = choice?.message?.content || "";
  const reasoningContent = (choice?.message as Record<string, unknown> | undefined)?.reasoning_content as string | undefined;
  const summary = reasoningContent ? `[Reasoning]\n${reasoningContent}\n\n[Answer]\n${assistantContent}` : assistantContent;

  const usage = data.usage;
  const usageSummary = usage
    ? {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
      }
    : undefined;

  await onLog("stdout", `[paperclip] DeepSeek response received. Tokens: ${usageSummary?.totalTokens ?? "unknown"}\n`);

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary,
    usage: usageSummary,
    sessionId: data.id || null,
    provider: "deepseek",
    biller: "deepseek",
    model,
    billingType: "api",
    resultJson: {
      model,
      choices: data.choices,
      usage: data.usage,
    },
  };
}
