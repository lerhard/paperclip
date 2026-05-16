import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function DeepSeekConfigFields({
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
      <Field label="Model" hint="DeepSeek model ID (default: deepseek-chat)">
        <DraftInput
          value={
            isCreate
              ? v?.model ?? ""
              : eff("adapterConfig", "model", String(c?.model ?? ""))
          }
          onCommit={(val) =>
            isCreate
              ? set!({ model: val || undefined })
              : mark("adapterConfig", "model", val || undefined)
          }
          immediate
          className={inputClass}
          placeholder="deepseek-chat"
        />
      </Field>

      <Field label="Max Tokens" hint="Max completion tokens (default: 2048)">
        <DraftInput
          type="number"
          value={
            isCreate
              ? String(v?.maxTokens ?? "")
              : eff("adapterConfig", "maxTokens", String(c?.maxTokens ?? ""))
          }
          onCommit={(val) =>
            isCreate
              ? set!({ maxTokens: val ? parseInt(val, 10) : undefined } as any)
              : mark("adapterConfig", "maxTokens", val ? parseInt(val, 10) : undefined)
          }
          immediate
          className={inputClass}
          placeholder="2048"
          min="1"
        />
      </Field>

      <Field label="Temperature" hint="Sampling temperature 0-2 (default: 0.7)">
        <DraftInput
          type="number"
          value={
            isCreate
              ? String(v?.temperature ?? "")
              : eff("adapterConfig", "temperature", String(c?.temperature ?? ""))
          }
          onCommit={(val) =>
            isCreate
              ? set!({ temperature: val ? parseFloat(val) : undefined } as any)
              : mark("adapterConfig", "temperature", val ? parseFloat(val) : undefined)
          }
          immediate
          className={inputClass}
          placeholder="0.7"
          min="0"
          max="2"
          step="0.1"
        />
      </Field>

      <Field label="System Prompt" hint="Custom system prompt (optional)">
        <DraftInput
          value={
            isCreate
              ? v?.systemPrompt ?? ""
              : eff("adapterConfig", "systemPrompt", String(c?.systemPrompt ?? ""))
          }
          onCommit={(val) =>
            isCreate
              ? set!({ systemPrompt: val || undefined } as any)
              : mark("adapterConfig", "systemPrompt", val || undefined)
          }
          immediate
          className={inputClass}
          placeholder="Paperclip AI agent..."
        />
      </Field>
    </>
  );
}
