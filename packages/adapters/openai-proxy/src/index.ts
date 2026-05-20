export const type = "openai_proxy" as const;
export const label = "OpenAI Proxy";

export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# openai_proxy config

Use when: you have a custom OpenAI-compatible API endpoint (e.g. a proxy or private deployment).

Core fields:
- baseUrl (string, required): The API base URL, e.g. "https://proxy.example.com/v1"
- apiKey (string, required): Bearer token for authentication
- model (string, required): Model ID to use, e.g. "gpt-4"
- systemPrompt (string, optional)
- temperature (number, optional): Default 0.7
- maxTokens (number, optional): Default 2048
- maxTurns (number, optional): Default 12
- timeoutSec (number, optional): Request timeout. Default 120

The adapter will call:
- {baseUrl}/models  (for model listing)
- {baseUrl}/chat/completions  (for execution)
`;

export interface OpenAiProxyConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  maxTurns?: number;
  timeoutSec?: number;
}
