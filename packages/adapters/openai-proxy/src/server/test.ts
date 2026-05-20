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

  if (!config.baseUrl) {
    checks.push({
      code: "openai_proxy_base_url_missing",
      level: "error",
      message: "baseUrl is required",
      hint: "Set adapterConfig.baseUrl to your OpenAI-compatible API endpoint.",
    });
  } else {
    checks.push({
      code: "openai_proxy_base_url_present",
      level: "info",
      message: `Base URL: ${config.baseUrl}`,
    });
  }

  if (!config.apiKey) {
    checks.push({
      code: "openai_proxy_api_key_missing",
      level: "error",
      message: "apiKey is required",
      hint: "Set adapterConfig.apiKey to your proxy bearer token.",
    });
  } else {
    checks.push({
      code: "openai_proxy_api_key_present",
      level: "info",
      message: "API key is configured",
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

  if (config.baseUrl && config.apiKey) {
    try {
      const modelsUrl = config.baseUrl.replace(/\/$/, "") + "/models";
      const res = await fetch(modelsUrl, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
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
