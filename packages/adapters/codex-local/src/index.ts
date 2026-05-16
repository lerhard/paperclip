import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "codex_local";
export const label = "Codex (local)";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @openai/codex";

export const DEFAULT_CODEX_LOCAL_MODEL = "gpt-5.3-codex";
export const DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX = true;
export const CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS = ["gpt-5.4"] as const;

function normalizeModelId(model: string | null | undefined): string {
  return typeof model === "string" ? model.trim() : "";
}

export function isCodexLocalKnownModel(model: string | null | undefined): boolean {
  const normalizedModel = normalizeModelId(model);
  if (!normalizedModel) return false;
  return models.some((entry) => entry.id === normalizedModel);
}

export function isCodexLocalManualModel(model: string | null | undefined): boolean {
  const normalizedModel = normalizeModelId(model);
  return Boolean(normalizedModel) && !isCodexLocalKnownModel(normalizedModel);
}

export function isCodexLocalFastModeSupported(model: string | null | undefined): boolean {
  if (isCodexLocalManualModel(model)) return true;
  const normalizedModel = typeof model === "string" ? model.trim() : "";
  return CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS.includes(
    normalizedModel as (typeof CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS)[number],
  );
}

export const models = [
  { id: "gpt-5.4", label: "gpt-5.4" },
  { id: DEFAULT_CODEX_LOCAL_MODEL, label: DEFAULT_CODEX_LOCAL_MODEL },
  { id: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark" },
  { id: "gpt-5", label: "gpt-5" },
  { id: "o3", label: "o3" },
  { id: "o4-mini", label: "o4-mini" },
  { id: "gpt-5-mini", label: "gpt-5-mini" },
  { id: "gpt-5-nano", label: "gpt-5-nano" },
  { id: "o3-mini", label: "o3-mini" },
  { id: "codex-mini-latest", label: "Codex Mini" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use the lowest-cost known Codex local model lane without changing the primary model.",
    adapterConfig: {
      model: "gpt-5.3-codex-spark",
      modelReasoningEffort: "low",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# codex_local config

Core fields:
- cwd (string, optional): working directory
- instructionsFilePath (string, optional): markdown instructions file path
- model (string, optional): Codex model id
- modelReasoningEffort (string, optional): minimal|low|medium|high|xhigh
- promptTemplate (string, optional)
- search (boolean, optional): run with --search
- fastMode (boolean, optional): enable Fast mode (GPT-5.4+)
- dangerouslyBypassApprovalsAndSandbox (boolean, optional)
- command (string, optional): default "codex"
- extraArgs (string[], optional)
- env (object, optional)
- workspaceStrategy (object, optional): { type: "git_worktree" }
- workspaceRuntime (object, optional)

Operational:
- timeoutSec, graceSec (number, optional)
`;
