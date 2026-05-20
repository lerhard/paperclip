import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function OpenAiProxyConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const v = values as any;
  const c = config as any;

  return (
    <>
      <Field label="Base URL" hint="OpenAI-compatible API base URL (e.g. https://proxy.example.com/v1)">
        <DraftInput
          value={
            isCreate
              ? v?.baseUrl ?? ""
              : eff("adapterConfig", "baseUrl", String(c?.baseUrl ?? ""))
          }
          onCommit={(val) =>
            isCreate
              ? set!({ baseUrl: val || undefined } as any)
              : mark("adapterConfig", "baseUrl", val || undefined)
          }
          immediate
          className={inputClass}
          placeholder="https://proxy.example.com/v1"
        />
      </Field>
      <Field label="API Key" hint="Bearer token for authentication">
        <DraftInput
          value={
            isCreate
              ? v?.apiKey ?? ""
              : eff("adapterConfig", "apiKey", String(c?.apiKey ?? ""))
          }
          onCommit={(val) =>
            isCreate
              ? set!({ apiKey: val || undefined } as any)
              : mark("adapterConfig", "apiKey", val || undefined)
          }
          immediate
          className={inputClass}
          placeholder="sk-..."
          type="password"
        />
      </Field>
      <Field label="Model" hint="Model ID (e.g. gpt-4)">
        <DraftInput
          value={
            isCreate
              ? v?.model ?? ""
              : eff("adapterConfig", "model", String(c?.model ?? ""))
          }
          onCommit={(val) =>
            isCreate
              ? set!({ model: val || undefined } as any)
              : mark("adapterConfig", "model", val || undefined)
          }
          immediate
          className={inputClass}
          placeholder="gpt-4"
        />
      </Field>
    </>
  );
}
