import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "gemini_local";
export const label = "Gemini CLI (local)";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @google/gemini-cli";

export const DEFAULT_GEMINI_LOCAL_MODEL = "auto";

export const models = [
  { id: DEFAULT_GEMINI_LOCAL_MODEL, label: "Auto" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  { id: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash Lite" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use Gemini Flash Lite as the budget Gemini CLI lane while preserving the primary model.",
    adapterConfig: {
      model: "gemini-2.5-flash-lite",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# gemini_local config

Core fields:
- cwd (string, optional): working directory
- instructionsFilePath (string, optional): markdown instructions file path
- promptTemplate (string, optional)
- model (string, optional): default "auto"
- sandbox (boolean, optional): default false
- command (string, optional): default "gemini"
- extraArgs (string[], optional)
- env (object, optional)

Operational:
- timeoutSec, graceSec (number, optional)
`;
