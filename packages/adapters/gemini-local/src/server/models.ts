import type { AdapterModel } from "@paperclipai/adapter-utils";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODELS_CACHE_TTL_MS = 60_000;

interface GeminiApiModel {
  name: string;
  displayName?: string;
  description?: string;
}

let cachedModels: { expiresAt: number; models: AdapterModel[] } | null = null;

function resolveApiKey(): string | null {
  return (
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    null
  );
}

function normalizeModelName(name: string): string {
  // API returns "models/gemini-2.5-pro", strip the prefix
  return name.replace(/^models\//, "");
}

export async function listGeminiModels(): Promise<AdapterModel[]> {
  const now = Date.now();
  if (cachedModels && cachedModels.expiresAt > now) {
    return cachedModels.models;
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    // Fallback to static list when no key is available
    return fallbackModels();
  }

  try {
    const res = await fetch(`${GEMINI_API_BASE}/models?key=${encodeURIComponent(apiKey)}`, {
      method: "GET",
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return fallbackModels();
    }

    const data = (await res.json()) as { models?: GeminiApiModel[] };
    const models = (data.models ?? [])
      .filter((m) => {
        const name = normalizeModelName(m.name);
        // Only include gemini models, exclude embeddings/vision-only/etc
        return name.startsWith("gemini-");
      })
      .map((m) => {
        const id = normalizeModelName(m.name);
        const label = m.displayName?.trim() || id;
        return { id, label };
      })
      .sort((a, b) => a.label.localeCompare(b.label));

    cachedModels = { expiresAt: now + MODELS_CACHE_TTL_MS, models };
    return models;
  } catch {
    return fallbackModels();
  }
}

function fallbackModels(): AdapterModel[] {
  return [
    { id: "auto", label: "Auto" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
    { id: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash Lite" },
  ];
}

export function resetGeminiModelsCache() {
  cachedModels = null;
}
