import type { AdapterModel } from "@paperclipai/adapter-utils";

export const type = "acpx_local";
export const label = "ACPX (local)";

export const DEFAULT_ACPX_LOCAL_AGENT = "claude";
export const DEFAULT_ACPX_LOCAL_MODE = "persistent";
export const DEFAULT_ACPX_LOCAL_PERMISSION_MODE = "approve-all";
export const DEFAULT_ACPX_LOCAL_NON_INTERACTIVE_PERMISSIONS = "deny";
export const DEFAULT_ACPX_LOCAL_TIMEOUT_SEC = 0;
export const DEFAULT_ACPX_LOCAL_WARM_HANDLE_IDLE_MS = 0;

export const acpxAgentOptions = [
  { id: "claude", label: "Claude via ACPX" },
  { id: "codex", label: "Codex via ACPX" },
  { id: "custom", label: "Custom ACP command" },
] as const;

export const models: AdapterModel[] = [];

export const agentConfigurationDoc = `# acpx_local config

Core fields:
- agent (string, optional): claude|codex|custom. Default claude.
- agentCommand (string, optional): custom ACP command
- mode (string, optional): persistent|oneshot. Default persistent.
- cwd (string, optional): working directory
- permissionMode (string, optional): default approve-all
- nonInteractivePermissions (string, optional): deny|fail
- stateDir, instructionsFilePath, promptTemplate, bootstrapPromptTemplate (string, optional)
- model (string, optional)
- effort/modelReasoningEffort (string, optional)
- fastMode (boolean, optional)
- timeoutSec (number, optional): default 0 (no timeout)
- warmHandleIdleMs (number, optional): default 0
- env (object, optional)
`;
