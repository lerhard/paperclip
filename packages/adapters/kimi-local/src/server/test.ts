import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "@paperclipai/adapter-utils";
import { KIMI_CHAT_ENDPOINT, type KimiConfig } from "../index.js";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = ctx.config as unknown as KimiConfig;

  const apiKey = config.apiKey || process.env.MOONSHOT_API_KEY;

  if (!apiKey) {
    checks.push({
      code: "kimi_api_key_missing",
      level: "error",
      message: "No Moonshot API key found",
      detail: "Set adapterConfig.apiKey or MOONSHOT_API_KEY environment variable.",
      hint: "Get a key at https://platform.moonshot.cn/",
    });
    return {
      adapterType: "kimi_local",
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  checks.push({
    code: "kimi_api_key_found",
    level: "info",
    message: `API key found: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`,
  });

  try {
    const res = await fetch(KIMI_CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "moonshot-v1-8k",
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 5,
      }),
    });

    if (res.ok) {
      checks.push({
        code: "kimi_api_reachable",
        level: "info",
        message: "Kimi API is reachable",
      });
    } else {
      const text = await res.text().catch(() => "unknown");
      checks.push({
        code: "kimi_api_error",
        level: "error",
        message: `Kimi API returned ${res.status}`,
        detail: text.slice(0, 240),
        hint: "Check your API key and account status at https://platform.moonshot.cn/",
      });
    }
  } catch (err) {
    checks.push({
      code: "kimi_api_unreachable",
      level: "error",
      message: "Could not reach Kimi API",
      detail: err instanceof Error ? err.message : String(err),
      hint: "Check network connectivity and DNS resolution for api.moonshot.cn",
    });
  }

  const hasError = checks.some((c) => c.level === "error");

  return {
    adapterType: "kimi_local",
    status: hasError ? "fail" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
