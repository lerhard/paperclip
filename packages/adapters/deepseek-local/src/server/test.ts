import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "@paperclipai/adapter-utils";
import { DEEPSEEK_CHAT_ENDPOINT, type DeepSeekConfig } from "../index.js";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = ctx.config as unknown as DeepSeekConfig;

  // ── 1. Check API key ──────────────────────────────────────────
  const apiKey = config.apiKey || process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    checks.push({
      code: "deepseek_api_key_missing",
      level: "error",
      message: "No DeepSeek API key found",
      detail: "Set adapterConfig.apiKey or DEEPSEEK_API_KEY environment variable.",
      hint: "Get a key at https://platform.deepseek.com/",
    });
    return {
      adapterType: "deepseek_local",
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  checks.push({
    code: "deepseek_api_key_found",
    level: "info",
    message: `API key found: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`,
  });

  // ── 2. Test API connectivity ──────────────────────────────────
  try {
    const res = await fetch(DEEPSEEK_CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 5,
      }),
    });

    if (res.ok) {
      checks.push({
        code: "deepseek_api_reachable",
        level: "info",
        message: "DeepSeek API is reachable",
      });
    } else {
      const text = await res.text().catch(() => "unknown");
      checks.push({
        code: "deepseek_api_error",
        level: "error",
        message: `DeepSeek API returned ${res.status}`,
        detail: text.slice(0, 240),
        hint: "Check your API key and account status at https://platform.deepseek.com/",
      });
    }
  } catch (err) {
    checks.push({
      code: "deepseek_api_unreachable",
      level: "error",
      message: "Could not reach DeepSeek API",
      detail: err instanceof Error ? err.message : String(err),
      hint: "Check network connectivity and DNS resolution for api.deepseek.com",
    });
  }

  const hasError = checks.some((c) => c.level === "error");

  return {
    adapterType: "deepseek_local",
    status: hasError ? "fail" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
