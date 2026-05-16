// ─────────────────────────────────────────────────────────────────
// @paperclipai/adapter-openrouter — Root Metadata (src/index.ts)
// Shared across server · ui · cli — keep dependency-free
// ─────────────────────────────────────────────────────────────────

export const type = "openrouter" as const;
export const label = "OpenRouter";

// ── Static fallback models (shown when API is unreachable) ──────
export const models = [
  // Free tier
  { id: "openrouter/auto",                       label: "Auto (best free route)" },
  { id: "meta-llama/llama-4-maverick:free",       label: "Llama 4 Maverick (free)" },
  { id: "meta-llama/llama-4-scout:free",          label: "Llama 4 Scout (free)" },
  { id: "google/gemma-3-27b-it:free",             label: "Gemma 3 27B (free)" },
  { id: "deepseek/deepseek-chat-v3-0324:free",    label: "DeepSeek V3 0324 (free)" },
  { id: "qwen/qwen3-235b-a22b:free",              label: "Qwen3 235B (free)" },
  { id: "mistralai/mistral-small-3.2-24b-instruct:free", label: "Mistral Small 3.2 (free)" },

  // Paid — frontier
  { id: "anthropic/claude-sonnet-4-6",            label: "Claude Sonnet 4.6" },
  { id: "anthropic/claude-opus-4-6",              label: "Claude Opus 4.6" },
  { id: "openai/gpt-4.1",                        label: "GPT-4.1" },
  { id: "openai/o4-mini",                         label: "o4-mini" },
  { id: "google/gemini-2.5-pro-preview",          label: "Gemini 2.5 Pro" },
  { id: "google/gemini-2.5-flash-preview",        label: "Gemini 2.5 Flash" },
  { id: "deepseek/deepseek-r1",                   label: "DeepSeek R1" },
  { id: "meta-llama/llama-4-maverick",            label: "Llama 4 Maverick" },

  // Paid — mid-tier
  { id: "anthropic/claude-haiku-4-5",             label: "Claude Haiku 4.5" },
  { id: "openai/gpt-4.1-mini",                   label: "GPT-4.1 Mini" },
  { id: "mistralai/mistral-medium-3",             label: "Mistral Medium 3" },
  { id: "qwen/qwen3-235b-a22b",                  label: "Qwen3 235B" },
];

// ── OpenRouter API constants ────────────────────────────────────
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_MODELS_ENDPOINT = `${OPENROUTER_BASE_URL}/models`;
export const OPENROUTER_CHAT_ENDPOINT = `${OPENROUTER_BASE_URL}/chat/completions`;
export const OPENROUTER_GENERATION_ENDPOINT = `${OPENROUTER_BASE_URL}/generation`;

// ── Adapter documentation ───────────────────────────────────────
export const agentConfigurationDoc = `# openrouter config

Use when: need 300+ models via single API key; auto-routing; models not in native adapters.

Core fields:
- model (string): e.g. "anthropic/claude-sonnet-4-6". Use "openrouter/auto" for auto-pick. Append ":free" for free tier.
- apiKey (string): OpenRouter key. Also via OPENROUTER_API_KEY env var.
- systemPrompt (string, optional)
- temperature (number, optional): Default 0.7
- maxTokens (number, optional): Default 2048 (token-optimized)
- topP, stream, reasoning, transforms, route, httpReferer, xTitle (optional)
- maxTurns (number, optional): Default 25
- autoApprove (boolean, optional): Skip approval gates
- compressToolResults, useRTK, useCaveman (boolean, optional): Enable token compression

Don't use when: you have direct provider API key; need local/offline inference.
`;

// ── Types ───────────────────────────────────────────────────────
export interface OpenRouterModel {
  id: string;
  name: string;
  pricing: {
    prompt: string;
    completion: string;
    request?: string;
    image?: string;
  };
  context_length: number;
  top_provider?: {
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  per_request_limits?: Record<string, string> | null;
  architecture?: {
    modality: string;
    tokenizer: string;
    instruct_type: string | null;
  };
}

export interface OpenRouterConfig {
  model: string;
  apiKey?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stream?: boolean;
  reasoning?: boolean;
  transforms?: string[];
  route?: "fallback" | "no-fallback";
  httpReferer?: string;
  xTitle?: string;
  /** Max tool-loop turns per run. Default 25. */
  maxTurns?: number;
  /** Skip approval gates for hire_agent and similar mutating tools. Default false. */
  autoApprove?: boolean;
  /** Override path to skills directory. Defaults to ~/.openrouter-adapter/skills. */
  skillsDir?: string;
  /** Absolute path to a markdown file that will be read at runtime and
   * prepended to the system prompt. Takes precedence over systemPrompt
   * if both are set. */
  instructionsFilePath?: string;
  /** Max messages to keep in context. Default: unlimited (undefined). */
  maxContextMessages?: number;
  /** Enable TOON/Varman compression on tool results. Default false. */
  compressToolResults?: boolean;
  /** Use RTK (Reduced Token Keys) for JSON key abbreviation. Default false. */
  useRTK?: boolean;
  /** Use Caveman ultra-minimal text compression. Default false. */
  useCaveman?: boolean;
}

