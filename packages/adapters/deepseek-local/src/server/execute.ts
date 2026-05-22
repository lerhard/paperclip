import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { DEEPSEEK_CHAT_ENDPOINT, type DeepSeekConfig } from "../index.js";
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
const TURN_DELAY_MS = 1200; // proactive delay to respect rate limits
const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_CONTEXT = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, context, onLog, agent, runId, authToken } = ctx;
  const dsConfig: DeepSeekConfig = (config as Record<string, unknown>) || {};

  const apiKey = resolveApiKey(dsConfig);
  const model = asString(dsConfig.model, "deepseek-chat");
  const temperature = asNumber(dsConfig.temperature, 0.7);
  const maxTokens = asNumber(dsConfig.maxTokens, 2048);
  const systemPrompt = asString(dsConfig.systemPrompt, DEFAULT_SYSTEM_PROMPT);
  const timeoutSec = asNumber(dsConfig.timeoutSec, 120);
  const maxTurns = asNumber((config as any).maxTurns, DEFAULT_MAX_TURNS);
  const maxContextMessages = asNumber((config as any).maxContextMessages, DEFAULT_MAX_CONTEXT);

  const apiBaseUrl = process.env.PAPERCLIP_API_URL || "http://localhost:3100";
  const currentIssueId =
    typeof context.issueId === "string" && context.issueId.trim().length > 0
      ? context.issueId.trim()
      : null;

  const tools = buildTools({
    agentId: agent.id,
    companyId: agent.companyId,
    currentIssueId,
    apiBaseUrl,
    apiKey: authToken || "",
    runId,
  });

  // Build prompt from wake context (already compressed by renderPaperclipWakePrompt)
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: false });
  const userPrompt = wakePrompt.length > 0 ? wakePrompt : "Continue your work.";

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let turnCount = 0;
  const toolResultCache = new Map<string, { content: string; isError: boolean }>();

  while (turnCount < maxTurns) {
    turnCount++;

    if (turnCount > 1) {
      await sleep(TURN_DELAY_MS);
    }

    // Truncate message history to keep token count bounded
    let messagesToSend = messages;
    if (messages.length > maxContextMessages + 1) {
      const systemMsg = messages[0];
      const recent = messages.slice(-maxContextMessages);
      messagesToSend = [systemMsg, ...recent];
    }

    const body: Record<string, unknown> = {
      model,
      messages: messagesToSend,
      temperature,
      max_tokens: maxTokens,
      tools: buildToolSchemas(tools),
    };

    if (model === "deepseek-chat" || model.includes("deepseek-v3")) {
      body.ephemeral = true;
    }

    await onLog("stdout", `[DS] t${turnCount}\n`);

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
    const message = choice?.message;

    if (data.usage) {
      totalInputTokens += data.usage.prompt_tokens ?? 0;
      totalOutputTokens += data.usage.completion_tokens ?? 0;
    }

    // Preserve reasoning in context so the model can continue its thought process across turns
    const reasoningContent = (message as Record<string, unknown> | undefined)?.reasoning_content as string | undefined;
    const assistantContent = message?.content || "";
    const contextContent = reasoningContent && reasoningContent.trim().length > 0
      ? `${reasoningContent.trim()}\n\n${assistantContent}`
      : assistantContent;

    messages.push({
      role: "assistant",
      content: contextContent,
      tool_calls: message?.tool_calls,
    });

    if (!message?.tool_calls || message.tool_calls.length === 0) {
      // Strip reasoning unavailable placeholder
      const cleanedContent = (message?.content || "").replace(/\[reasoning unavailable\]/gi, "").trim();
      const reasoningContent = (message as Record<string, unknown> | undefined)?.reasoning_content as string | undefined;
      if (reasoningContent && reasoningContent.trim().length > 0) {
        await onLog("stdout", `[thinking] ${reasoningContent.trim()}\n`);
      }

      await onLog("stdout", `[DS] done ${turnCount}t\n`);

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: cleanedContent,
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        },
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

    // Execute tool calls
    for (const toolCall of message.tool_calls) {
      const toolName = toolCall.function.name;
      const tool = findTool(tools, toolName);

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        messages.push({
          role: "tool",
          content: JSON.stringify({ error: "Invalid tool arguments JSON" }),
          tool_call_id: toolCall.id,
        });
        continue;
      }

      const cacheKey = `${toolName}::${JSON.stringify(args)}`;
      const cached = toolResultCache.get(cacheKey);
      if (cached) {
        messages.push({
          role: "tool",
          content: cached.content,
          tool_call_id: toolCall.id,
        });
        continue;
      }

      if (!tool) {
        const errContent = JSON.stringify({ error: `Unknown tool: ${toolName}` });
        messages.push({
          role: "tool",
          content: errContent,
          tool_call_id: toolCall.id,
        });
        toolResultCache.set(cacheKey, { content: errContent, isError: true });
        continue;
      }

      await onLog("stdout", `[>] ${toolName}\n`);
      const result = await tool.execute(args);
      messages.push({
        role: "tool",
        content: result.content,
        tool_call_id: toolCall.id,
      });
      toolResultCache.set(cacheKey, { content: result.content, isError: result.isError });
    }
  }

  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: `Max turns (${maxTurns}) reached without completion`,
    errorCode: "max_turns_exhausted",
  };
}
