export const type = "deepseek_local" as const;
export const label = "DeepSeek (local API)";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_CHAT_ENDPOINT = `${DEEPSEEK_BASE_URL}/chat/completions`;

export const models = [
  { id: "deepseek-chat", label: "DeepSeek-V3" },
  { id: "deepseek-reasoner", label: "DeepSeek-R1" },
];

export const agentConfigurationDoc = `# deepseek_local agent configuration

Adapter: deepseek_local

Use when:
- You want to use DeepSeek models via the official DeepSeek API
- You need a cost-effective alternative to frontier models

Don't use when:
- You need local/offline inference (use ollama or process adapter instead)
- You don't have a DeepSeek API key

Core fields:
- model (string, optional): DeepSeek model ID. Defaults to "deepseek-chat".
  - "deepseek-chat" — DeepSeek-V3 (general purpose)
  - "deepseek-reasoner" — DeepSeek-R1 (reasoning)
- apiKey (string, optional): Your DeepSeek API key.
  Can also be set via DEEPSEEK_API_KEY environment variable.
- temperature (number, optional): Sampling temperature (0-2). Default: 0.7
- maxTokens (number, optional): Max completion tokens. Default: 2048 (token-optimized)
- systemPrompt (string, optional): System prompt prepended to all messages.
- timeoutSec (number, optional): Request timeout in seconds. Default: 120

Operational fields:
- instructionsFilePath (string, optional): absolute path to a markdown instructions file
`;

export interface DeepSeekConfig {
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  timeoutSec?: number;
  instructionsFilePath?: string;
}
