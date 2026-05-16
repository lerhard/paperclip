import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "claude_local";
export const label = "Claude Code (local)";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @anthropic-ai/claude-code";

export const models = [
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-6", label: "Claude Haiku 4.6" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use Claude Sonnet as the lower-cost Claude Code lane while preserving the agent's primary model.",
    adapterConfig: {
      model: "claude-sonnet-4-6",
      effort: "low",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# claude_local config

Core fields:
- cwd (string, optional): working directory
- instructionsFilePath (string, optional): markdown instructions file path
- model (string, optional): Claude model id
- effort (string, optional): low|medium|high
- chrome (boolean, optional): pass --chrome
- promptTemplate (string, optional)
- maxTurnsPerRun (number, optional)
- dangerouslySkipPermissions (boolean, optional, default true): skip permission prompts in headless mode
- command (string, optional): default "claude"
- extraArgs (string[], optional): additional CLI args
- env (object, optional)
- workspaceStrategy (object, optional): { type: "git_worktree" }
- workspaceRuntime (object, optional)

Operational:
- timeoutSec, graceSec (number, optional)
`;
