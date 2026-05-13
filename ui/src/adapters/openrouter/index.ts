import type { UIAdapterModule, CreateConfigValues } from "../types";
import { OpenRouterConfigFields } from "./config-fields";

// Simple stdout parser for OpenRouter
function parseStdout(line: string) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
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
