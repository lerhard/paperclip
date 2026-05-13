import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function OpenRouterConfigFields({
  mode,
  isCreate,
  values,
  config,
  eff,
  mark,
  set,
}: AdapterConfigFieldsProps) {
  return (
    <>
      {/* Token Optimization Section */}
      <div className="space-y-3 pt-2">
        <div className="text-xs font-medium text-muted-foreground">Token Optimization</div>
        
        <Field
          label="Max Turns"
          hint="Maximum number of tool-calling iterations (default: 25). Lower = fewer tokens."
        >
          <DraftInput
            type="number"
            value={
              isCreate
                ? String(values!.maxTurns ?? "")
                : eff("adapterConfig", "maxTurns", String(config.maxTurns ?? ""))
            }
            onCommit={(v) =>
              isCreate
                ? set!({ maxTurns: v ? parseInt(v, 10) : undefined })
                : mark("adapterConfig", "maxTurns", v ? parseInt(v, 10) : undefined)
            }
            immediate
            className={inputClass}
            placeholder="25"
            min="1"
            max="100"
          />
        </Field>

        <Field
          label="Max Context Messages"
          hint="Keep only last N messages in context. Recommended: 8-12 for 40-60% token savings."
        >
          <DraftInput
            type="number"
            value={
              isCreate
                ? String(values!.maxContextMessages ?? "")
                : eff("adapterConfig", "maxContextMessages", String(config.maxContextMessages ?? ""))
            }
            onCommit={(v) =>
              isCreate
                ? set!({ maxContextMessages: v ? parseInt(v, 10) : undefined })
                : mark("adapterConfig", "maxContextMessages", v ? parseInt(v, 10) : undefined)
            }
            immediate
            className={inputClass}
            placeholder="unlimited"
            min="4"
            max="50"
          />
        </Field>

        <ToggleField
          label="Compress Tool Results"
          hint="Use TOON/Varman compression on tool results for 30-50% token savings. Safe to enable."
          value={
            isCreate
              ? Boolean(values!.compressToolResults)
              : eff("adapterConfig", "compressToolResults", Boolean(config.compressToolResults))
          }
          onChange={(v) =>
            isCreate
              ? set!({ compressToolResults: v })
              : mark("adapterConfig", "compressToolResults", v)
          }
        />

        <ToggleField
          label="Use RTK (Reduced Token Keys)"
          hint="Abbreviate JSON keys (id→i, name→n, etc). Adds 20-40% savings. Requires compressToolResults."
          value={
            isCreate
              ? Boolean(values!.useRTK)
              : eff("adapterConfig", "useRTK", Boolean(config.useRTK))
          }
          onChange={(v) =>
            isCreate
              ? set!({ useRTK: v })
              : mark("adapterConfig", "useRTK", v)
          }
        />

        <ToggleField
          label="Use Caveman Compression"
          hint="Ultra-minimal English (removes articles, prepositions). 30-50% text savings. Use with caution."
          value={
            isCreate
              ? Boolean(values!.useCaveman)
              : eff("adapterConfig", "useCaveman", Boolean(config.useCaveman))
          }
          onChange={(v) =>
            isCreate
              ? set!({ useCaveman: v })
              : mark("adapterConfig", "useCaveman", v)
          }
        />
      </div>
    </>
  );
}
