import type { UIAdapterModule, CreateConfigValues, TranscriptEntry } from "../types";
import { OpenRouterConfigFields } from "./config-fields";

// Parse stdout line into transcript entries.
// The OpenRouter adapter emits JSON objects per line; convert them to TranscriptEntry[].
function parseStdout(line: string, ts: string): TranscriptEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Not JSON — treat as plain stdout
    return [{ kind: "stdout" as const, ts, text: line }];
  }

  // If it's already an array, validate each item has a kind
  if (Array.isArray(parsed)) {
    return parsed.filter((item): item is TranscriptEntry =>
      typeof item === "object" && item !== null && "kind" in item
    );
  }

  // Single JSON object — convert based on kind
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
        // Unknown kind — treat as stdout with the raw JSON
        return [{ kind: "stdout" as const, ts, text: line }];
    }
  }

  // JSON but not a recognized transcript object
  return [{ kind: "stdout" as const, ts, text: line }];
}

// Build adapter config from form values
function buildConfig(values: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  
  // Model
  if (values.model) config.model = values.model;
  
  // Token optimization
  const v = values as any;
  if (v.maxTurns !== undefined) config.maxTurns = v.maxTurns;
  if (v.maxContextMessages !== undefined) config.maxContextMessages = v.maxContextMessages;
  if (v.compressToolResults !== undefined) config.compressToolResults = v.compressToolResults;
  if (v.useRTK !== undefined) config.useRTK = v.useRTK;
  if (v.useCaveman !== undefined) config.useCaveman = v.useCaveman;
  
  // Instructions file
  if (values.instructionsFilePath) config.instructionsFilePath = values.instructionsFilePath;
  
  return config;
}

export const openrouterUIAdapter: UIAdapterModule = {
  type: "openrouter",
  label: "OpenRouter",
  parseStdoutLine: parseStdout,
  ConfigFields: OpenRouterConfigFields,
  buildAdapterConfig: buildConfig,
};
