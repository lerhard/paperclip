import type {
  AdapterSessionCodec,
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";

const POPULAR_OPENAI_MODELS = [
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "gpt-4o-mini", label: "GPT-4o Mini" },
  { id: "gpt-4-turbo", label: "GPT-4 Turbo" },
  { id: "gpt-4", label: "GPT-4" },
  { id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo" },
  { id: "o1-preview", label: "o1 Preview" },
  { id: "o1-mini", label: "o1 Mini" },
  { id: "o3-mini", label: "o3 Mini" },
];

async function fetchProxyModels(opts?: { baseUrl?: string; apiKey?: string }): Promise<{ id: string; label: string }[]> {
  const baseUrl = (opts?.baseUrl || process.env.OPENAI_PROXY_BASE_URL || "").replace(/\/$/, "");
  const apiKey = opts?.apiKey || process.env.OPENAI_PROXY_API_KEY || "";
  if (!baseUrl || !apiKey) {
    // No credentials available — return popular defaults so the UI model picker works
    return POPULAR_OPENAI_MODELS;
  }

  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      // API returned error — still return defaults so the user isn't blocked
      return POPULAR_OPENAI_MODELS;
    }
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const models = Array.isArray(data.data) ? data.data : [];
    if (models.length === 0) return POPULAR_OPENAI_MODELS;
    return models.map((m) => ({ id: m.id, label: m.id }));
  } catch {
    return POPULAR_OPENAI_MODELS;
  }
}

export async function listModels(): Promise<{ id: string; label: string }[]> {
  return fetchProxyModels();
}

export async function refreshModels(): Promise<{ id: string; label: string }[]> {
  return fetchProxyModels();
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    const id = typeof obj.lastGenerationId === "string" ? obj.lastGenerationId : null;
    if (!id) return null;
    return { lastGenerationId: id };
  },
  serialize(params: unknown) {
    if (!params || typeof params !== "object") return null;
    const id = (params as Record<string, unknown>).lastGenerationId;
    return typeof id === "string" ? { lastGenerationId: id } : null;
  },
  getDisplayId(params: unknown) {
    if (!params || typeof params !== "object") return null;
    const id = (params as Record<string, unknown>).lastGenerationId;
    return typeof id === "string" ? id : null;
  },
};

export async function listSkills(_ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return {
    adapterType: "openai_proxy",
    supported: false,
    mode: "unsupported",
    desiredSkills: [],
    entries: [],
    warnings: [],
  };
}

export async function syncSkills(
  _ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return {
    adapterType: "openai_proxy",
    supported: false,
    mode: "unsupported",
    desiredSkills: [],
    entries: [],
    warnings: [],
  };
}
