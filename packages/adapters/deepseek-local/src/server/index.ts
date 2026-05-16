import type {
  AdapterSessionCodec,
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";

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
    adapterType: "deepseek_local",
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
    adapterType: "deepseek_local",
    supported: false,
    mode: "unsupported",
    desiredSkills: [],
    entries: [],
    warnings: [],
  };
}
