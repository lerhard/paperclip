export const type = "kimi_local" as const;
export const label = "Kimi (Moonshot AI)";

export const KIMI_BASE_URL = "https://api.moonshot.cn";
export const KIMI_CHAT_ENDPOINT = `${KIMI_BASE_URL}/v1/chat/completions`;

export const models = [
  { id: "moonshot-v1-8k", label: "Moonshot v1 8K" },
  { id: "moonshot-v1-32k", label: "Moonshot v1 32K" },
  { id: "moonshot-v1-128k", label: "Moonshot v1 128K" },
];

export const agentConfigurationDoc = `# kimi_local agent configuration

Adapter: kimi_local

Use when:
- You want to use Moonshot AI (Kimi) models via the official API
- You need long-context inference (up to 128K tokens)

Don't use when:
- You need local/offline inference (use ollama or process adapter instead)
- You don't have a Moonshot API key

Core fields:
- model (string, optional): Kimi model ID. Defaults to "moonshot-v1-8k".
  - "moonshot-v1-8k" — Standard context (8K)
  - "moonshot-v1-32k" — Extended context (32K)
  - "moonshot-v1-128k" — Long context (128K)
- apiKey (string, optional): Your Moonshot API key.
  Can also be set via MOONSHOT_API_KEY environment variable.
- temperature (number, optional): Sampling temperature (0-1). Default: 0.7
- maxTokens (number, optional): Max completion tokens. Default: 2048 (token-optimized)
- systemPrompt (string, optional): System prompt prepended to all messages.
- timeoutSec (number, optional): Request timeout in seconds. Default: 120

Operational fields:
- instructionsFilePath (string, optional): absolute path to a markdown instructions file
`;

export interface KimiConfig {
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  timeoutSec?: number;
  instructionsFilePath?: string;
}
