import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "pi_local";
export const label = "Pi (local)";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @earendil-works/pi-coding-agent@0.74.0";

export const models: Array<{ id: string; label: string }> = [];

export const modelProfiles: AdapterModelProfileDefinition[] = [];

export const agentConfigurationDoc = `# pi_local config

Core fields:
- cwd (string, optional): working directory
- instructionsFilePath (string, optional): markdown instructions file path
- promptTemplate (string, optional)
- model (string, required): provider/model format e.g. "xai/grok-4"
- thinking (string, optional): off|minimal|low|medium|high|xhigh
- command (string, optional): default "pi"
- env (object, optional)

Operational:
- timeoutSec, graceSec (number, optional)
`;
