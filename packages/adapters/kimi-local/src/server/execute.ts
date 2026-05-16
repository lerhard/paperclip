import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { KIMI_CHAT_ENDPOINT, type KimiConfig } from "../index.js";
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

const DEFAULT_SYSTEM_PROMPT =
  "Paperclip AI agent. EXECUTE tasks using tools. No descriptions — only actions. End with update_issue_status=done.";

function resolveApiKey(config: KimiConfig): string {
  const key = config.apiKey || process.env.MOONSHOT_API_KEY || "";
  if (!key) {
    throw new Error(
      "Moonshot API key not found. Set adapterConfig.apiKey or MOONSHOT_API_KEY env var.",
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
  const kimiConfig: KimiConfig = (config as Record<string, unknown>) || {};

  const apiKey = resolveApiKey(kimiConfig);
  const model = asString(kimiConfig.model, "moonshot-v1-8k");
  const temperature = asNumber(kimiConfig.temperature, 0.7);
  const maxTokens = asNumber(kimiConfig.maxTokens, 2048);
  const systemPrompt = asString(kimiConfig.systemPrompt, DEFAULT_SYSTEM_PROMPT);
  const timeoutSec = asNumber(kimiConfig.timeoutSec, 120);
  const maxTurns = asNumber((config as any).maxTurns, 10);

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

  while (turnCount < maxTurns) {
    turnCount++;
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      tools: buildToolSchemas(tools),
    };

    await onLog("stdout", `[paperclip] Kimi turn ${turnCount}: ${messages.length} messages\n`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

    let response: Response;
    try {
      response = await fetch(KIMI_CHAT_ENDPOINT, {
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
          errorMessage: `Kimi request timed out after ${timeoutSec}s`,
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
        errorMessage: `Kimi API returned ${response.status}: ${text.slice(0, 500)}`,
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

    messages.push({
      role: "assistant",
      content: message?.content || "",
      tool_calls: message?.tool_calls,
    });

    if (!message?.tool_calls || message.tool_calls.length === 0) {
      const summary = message?.content || "";

      await onLog("stdout", `[paperclip] Kimi done. Turns: ${turnCount}\n`);

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary,
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        },
        sessionId: data.id || null,
        provider: "moonshot",
        biller: "moonshot",
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
      const tool = findTool(tools, toolCall.function.name);
      if (!tool) {
        messages.push({
          role: "tool",
          content: JSON.stringify({ error: `Unknown tool: ${toolCall.function.name}` }),
          tool_call_id: toolCall.id,
        });
        continue;
      }

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

      await onLog("stdout", `[paperclip] Tool call: ${toolCall.function.name}\n`);
      const result = await tool.execute(args);
      messages.push({
        role: "tool",
        content: result.content,
        tool_call_id: toolCall.id,
      });
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
