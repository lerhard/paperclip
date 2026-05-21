import type { UIAdapterModule, CreateConfigValues, TranscriptEntry } from "../types";
import { OpenAiProxyConfigFields } from "./config-fields";

function parseStdout(line: string, ts: string): TranscriptEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [{ kind: "stdout" as const, ts, text: line }];
  }

  if (Array.isArray(parsed)) {
    return parsed.filter((item): item is TranscriptEntry =>
      typeof item === "object" && item !== null && "kind" in item
    );
  }

  if (typeof parsed === "object" && parsed !== null && "kind" in parsed) {
    const entry = parsed as Record<string, unknown>;
    const kind = entry.kind as string;

    switch (kind) {
      case "init":
        return [{
          kind: "init" as const,
          ts: (entry.ts as string) || ts,
          model: (entry.model as string) || "",
          sessionId: (entry.sessionId as string) || "",
        }];
      case "assistant":
        return [{
          kind: "assistant" as const,
          ts: (entry.ts as string) || ts,
          text: (entry.text as string) || "",
          delta: entry.delta as boolean | undefined,
        }];
      case "thinking":
        return [{
          kind: "thinking" as const,
          ts: (entry.ts as string) || ts,
          text: (entry.text as string) || "",
          delta: entry.delta as boolean | undefined,
        }];
      case "user":
        return [{
          kind: "user" as const,
          ts: (entry.ts as string) || ts,
          text: (entry.text as string) || "",
        }];
      case "tool_call":
        return [{
          kind: "tool_call" as const,
          ts: (entry.ts as string) || ts,
          name: (entry.name as string) || "",
          input: entry.input,
          toolUseId: entry.toolUseId as string | undefined,
        }];
      case "tool_result":
        return [{
          kind: "tool_result" as const,
          ts: (entry.ts as string) || ts,
          toolUseId: (entry.toolUseId as string) || "",
          toolName: entry.toolName as string | undefined,
          content: (entry.content as string) || "",
          isError: (entry.isError as boolean) ?? false,
        }];
      case "result":
        return [{
          kind: "result" as const,
          ts: (entry.ts as string) || ts,
          text: (entry.text as string) || "",
          inputTokens: (entry.inputTokens as number) ?? 0,
          outputTokens: (entry.outputTokens as number) ?? 0,
          cachedTokens: (entry.cachedTokens as number) ?? 0,
          costUsd: (entry.costUsd as number) ?? 0,
          subtype: (entry.subtype as string) || "",
          isError: (entry.isError as boolean) ?? false,
          errors: Array.isArray(entry.errors) ? (entry.errors as string[]) : [],
        }];
      case "stderr":
        return [{
          kind: "stderr" as const,
          ts: (entry.ts as string) || ts,
          text: (entry.text as string) || "",
        }];
      case "system":
        return [{
          kind: "system" as const,
          ts: (entry.ts as string) || ts,
          text: (entry.text as string) || "",
        }];
      case "stdout":
        return [{
          kind: "stdout" as const,
          ts: (entry.ts as string) || ts,
          text: (entry.text as string) || "",
        }];
      case "diff":
        return [{
          kind: "diff" as const,
          ts: (entry.ts as string) || ts,
          changeType: (entry.changeType as "add" | "remove" | "context" | "hunk" | "file_header" | "truncation") || "context",
          text: (entry.text as string) || "",
        }];
      default:
        return [{ kind: "stdout" as const, ts, text: line }];
    }
  }

  return [{ kind: "stdout" as const, ts, text: line }];
}

function buildConfig(values: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (values.model) config.model = values.model;
  const v = values as any;
  if (v.baseUrl !== undefined) config.baseUrl = v.baseUrl;
  if (v.apiKey !== undefined) config.apiKey = v.apiKey;
  if (v.maxTurns !== undefined) config.maxTurns = v.maxTurns;
  if (v.maxTokens !== undefined) config.maxTokens = v.maxTokens;
  if (v.temperature !== undefined) config.temperature = v.temperature;
  if (v.systemPrompt !== undefined) config.systemPrompt = v.systemPrompt;
  if (v.skillsDir !== undefined) config.skillsDir = v.skillsDir;
  if (values.instructionsFilePath) config.instructionsFilePath = values.instructionsFilePath;
  return config;
}

export const openaiProxyUIAdapter: UIAdapterModule = {
  type: "openai_proxy",
  label: "OpenAI Proxy",
  parseStdoutLine: parseStdout,
  ConfigFields: OpenAiProxyConfigFields,
  buildAdapterConfig: buildConfig,
};
