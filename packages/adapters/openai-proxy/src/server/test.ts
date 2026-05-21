import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import type { OpenAiProxyConfig } from "../index.js";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = (ctx.config || {}) as unknown as OpenAiProxyConfig;

  const effectiveBaseUrl = config.baseUrl || process.env.OPENAI_PROXY_BASE_URL || "";
  const effectiveApiKey = config.apiKey || process.env.OPENAI_PROXY_API_KEY || "";

  if (!effectiveBaseUrl) {
    checks.push({
      code: "openai_proxy_base_url_missing",
      level: "error",
      message: "baseUrl is required",
      hint: "Set adapterConfig.baseUrl or OPENAI_PROXY_BASE_URL env var.",
    });
  } else if (config.baseUrl) {
    checks.push({
      code: "openai_proxy_base_url_present",
      level: "info",
      message: `Base URL: ${effectiveBaseUrl}`,
    });
  } else {
    checks.push({
      code: "openai_proxy_base_url_from_env",
      level: "info",
      message: `Base URL from env: ${effectiveBaseUrl}`,
    });
  }

  if (!effectiveApiKey) {
    checks.push({
      code: "openai_proxy_api_key_missing",
      level: "error",
      message: "apiKey is required",
      hint: "Set adapterConfig.apiKey or OPENAI_PROXY_API_KEY env var.",
    });
  } else if (config.apiKey) {
    checks.push({
      code: "openai_proxy_api_key_present",
      level: "info",
      message: "API key is configured",
    });
  } else {
    checks.push({
      code: "openai_proxy_api_key_from_env",
      level: "info",
      message: "API key from env",
    });
  }

  if (!config.model) {
    checks.push({
      code: "openai_proxy_model_missing",
      level: "warn",
      message: "No model configured",
      hint: "Set adapterConfig.model to a valid model ID from your proxy.",
    });
  } else {
    checks.push({
      code: "openai_proxy_model_present",
      level: "info",
      message: `Model: ${config.model}`,
    });
  }

  if (effectiveBaseUrl && effectiveApiKey) {
    try {
      const modelsUrl = effectiveBaseUrl.replace(/\/$/, "") + "/models";
      const res = await fetch(modelsUrl, {
        headers: { Authorization: `Bearer ${effectiveApiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = (await res.json()) as { data?: unknown[] };
        const count = Array.isArray(data.data) ? data.data.length : 0;
        checks.push({
          code: "openai_proxy_models_ok",
          level: "info",
          message: `Connected — ${count} models available`,
        });
      } else {
        const text = await res.text().catch(() => "unknown");
        checks.push({
          code: "openai_proxy_models_failed",
          level: "warn",
          message: `Models endpoint returned ${res.status}`,
          detail: text.slice(0, 240),
        });
      }
    } catch (err) {
      checks.push({
        code: "openai_proxy_models_error",
        level: "warn",
        message: err instanceof Error ? err.message : "Could not reach proxy",
        hint: "Verify the baseUrl and network connectivity from the Paperclip server.",
      });
    }
  }

  const hasError = checks.some((c) => c.level === "error");

  return {
    adapterType: "openai_proxy",
    status: hasError ? "fail" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
