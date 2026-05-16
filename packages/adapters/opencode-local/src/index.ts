import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "opencode_local";
export const label = "OpenCode (local)";

// Use OpenCode's official installer instead of `npm install -g opencode-ai`.
// The npm package reifies four large Linux x64 prebuilt-binary subpackages
// (linux-x64, linux-x64-musl, linux-x64-baseline, linux-x64-baseline-musl) in
// parallel even though only one matches the sandbox; on bandwidth-constrained
// sandboxes (e.g. Cloudflare) that exceeded the 240s install budget. The
// official installer fetches a single arch-specific binary and adds
// `$HOME/.opencode/bin` to PATH via `~/.bashrc`, which sandbox `sh -lc`
// invocations source.
//
// Security tradeoff: this is `curl | bash` without a SHA-256 verification of
// the install script. We accept this because:
//   1. The install runs inside an isolated, ephemeral sandbox — blast radius
//      is bounded to that sandbox's secrets and disk.
//   2. The prior `npm install -g opencode-ai` is also unverified code
//      execution from a third-party registry; this is not strictly worse.
//   3. OpenCode does not publish per-release SHA-256 checksums in a stable
//      location, and pinning a version + hash here would require manual
//      version bumps on every OpenCode release.
// The `set -e` (implied by Bash's default with `-fsSL` upstream of a piped
// shell) and `curl -fsSL` give us fail-fast behavior on HTTP errors. If
// OpenCode starts publishing a stable checksum/signature, switch to fetching
// a versioned tarball + verifying the digest before exec.
export const SANDBOX_INSTALL_COMMAND = "curl -fsSL https://opencode.ai/install | bash";

export const DEFAULT_OPENCODE_LOCAL_MODEL = "openai/gpt-5.2-codex";

export function isValidOpenCodeModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const slashIndex = trimmed.indexOf("/");
  return Boolean(trimmed) && slashIndex > 0 && slashIndex !== trimmed.length - 1;
}

export const models: Array<{ id: string; label: string }> = [
  { id: DEFAULT_OPENCODE_LOCAL_MODEL, label: DEFAULT_OPENCODE_LOCAL_MODEL },
  { id: "openai/gpt-5.4", label: "openai/gpt-5.4" },
  { id: "openai/gpt-5.2", label: "openai/gpt-5.2" },
  { id: "openai/gpt-5.1-codex-max", label: "openai/gpt-5.1-codex-max" },
  { id: "openai/gpt-5.1-codex-mini", label: "openai/gpt-5.1-codex-mini" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use OpenCode's known Codex mini model as the budget lane.",
    adapterConfig: {
      model: "openai/gpt-5.1-codex-mini",
      variant: "low",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# opencode_local config

Core fields:
- cwd (string, optional): working directory
- instructionsFilePath (string, optional): markdown instructions file path
- model (string, required): provider/model format e.g. "anthropic/claude-sonnet-4-5"
- variant (string, optional): minimal|low|medium|high|xhigh|max
- dangerouslySkipPermissions (boolean, optional): default true for headless runs
- promptTemplate (string, optional)
- command (string, optional): default "opencode"
- extraArgs (string[], optional)
- env (object, optional)

Operational:
- timeoutSec, graceSec (number, optional)
`;
