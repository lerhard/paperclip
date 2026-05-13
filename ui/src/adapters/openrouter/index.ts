import type { UIAdapterModule } from "../types";
import { parseStdout } from "@paperclipai/adapter-openrouter/ui";
import { OpenRouterConfigFields } from "./config-fields";
import { buildConfig } from "@paperclipai/adapter-openrouter/ui";

export const openrouterUIAdapter: UIAdapterModule = {
  type: "openrouter",
  label: "OpenRouter",
  parseStdoutLine: parseStdout,
  ConfigFields: OpenRouterConfigFields,
  buildAdapterConfig: buildConfig,
};
