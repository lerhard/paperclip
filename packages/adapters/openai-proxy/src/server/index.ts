import type {
  AdapterSessionCodec,
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";

async function fetchProxyModels(): Promise<{ id: string; label: string }[]> {
  const baseUrl = (process.env.OPENAI_PROXY_BASE_URL || "").replace(/\/$/, "");
  const apiKey = process.env.OPENAI_PROXY_API_KEY || "";
  if (!baseUrl || !apiKey) return [];

  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const models = Array.isArray(data.data) ? data.data : [];
    return models.map((m) => ({ id: m.id, label: m.id }));
  } catch {
    return [];
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
