/**
 * Token compression utilities for OpenRouter adapter
 * Implements TOON (Token-Efficient Columnar Notation) and Varman-style compression
 */

// ----- TOON (Token-Efficient Columnar Notation) -----

/**
 * Convert JSON object to TOON format (columnar, pipe-separated)
 * Example:
 *   Input:  [{ id: "1", name: "John", age: 30 }, { id: "2", name: "Jane", age: 25 }]
 *   Output: "id|name|age\n1|John|30\n2|Jane|25"
 * 
 * Token savings: ~40-60% vs JSON
 */
export function toTOON(data: unknown): string {
  if (!data) return "";
  
  // Handle arrays of objects (most common case)
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
    const objects = data as Record<string, unknown>[];
    const keys = Object.keys(objects[0]);
    
    // Header row
    const header = keys.join("|");
    
    // Data rows
    const rows = objects.map(obj => 
      keys.map(k => {
        const val = obj[k];
        if (val === null || val === undefined) return "";
        if (typeof val === "object") return JSON.stringify(val);
        return String(val);
      }).join("|")
    );
    
    return [header, ...rows].join("\n");
  }
  
  // Handle single object
  if (typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const entries = Object.entries(obj);
    
    return entries.map(([k, v]) => {
      if (v === null || v === undefined) return `${k}:`;
      if (typeof v === "object") return `${k}:${JSON.stringify(v)}`;
      return `${k}:${v}`;
    }).join("|");
  }
  
  // Fallback to string
  return String(data);
}

/**
 * Parse TOON format back to JSON
 */
export function fromTOON(toon: string): unknown {
  if (!toon || !toon.includes("|")) return toon;
  
  const lines = toon.trim().split("\n");
  if (lines.length === 0) return null;
  
  // Check if it's tabular format (header + rows)
  if (lines.length > 1) {
    const header = lines[0].split("|");
    const rows = lines.slice(1);
    
    return rows.map(row => {
      const values = row.split("|");
      const obj: Record<string, unknown> = {};
      
      header.forEach((key, i) => {
        const val = values[i];
        if (!val) {
          obj[key] = null;
        } else if (val.startsWith("{") || val.startsWith("[")) {
          try {
            obj[key] = JSON.parse(val);
          } catch {
            obj[key] = val;
          }
        } else {
          obj[key] = val;
        }
      });
      
      return obj;
    });
  }
  
  // Single object format (key:value|key:value)
  const obj: Record<string, unknown> = {};
  const pairs = lines[0].split("|");
  
  pairs.forEach(pair => {
    const [key, ...valueParts] = pair.split(":");
    const value = valueParts.join(":");
    
    if (!value) {
      obj[key] = null;
    } else if (value.startsWith("{") || value.startsWith("[")) {
      try {
        obj[key] = JSON.parse(value);
      } catch {
        obj[key] = value;
      }
    } else {
      obj[key] = value;
    }
  });
  
  return obj;
}

// ----- RTK (Reduced Token Keys) -----

/**
 * Common JSON key abbreviations for RTK compression
 * Maps full key names to single-letter abbreviations
 */
const RTK_KEY_MAP: Record<string, string> = {
  // Common fields
  id: "i",
  name: "n",
  title: "t",
  description: "d",
  status: "s",
  type: "y",
  created: "c",
  updated: "u",
  assignee: "a",
  priority: "p",
  body: "b",
  content: "x",
  message: "m",
  error: "e",
  result: "r",
  value: "v",
  key: "k",
  data: "z",
  items: "l",
  count: "q",
  total: "o",
  // Issue fields
  issueId: "ii",
  companyId: "ci",
  agentId: "ai",
  userId: "ui",
  // Timestamps
  createdAt: "ca",
  updatedAt: "ua",
  deletedAt: "da",
};

/**
 * Reverse map for RTK decompression
 */
const RTK_REVERSE_MAP = Object.fromEntries(
  Object.entries(RTK_KEY_MAP).map(([k, v]) => [v, k])
);

/**
 * Apply RTK (Reduced Token Keys) compression to JSON object
 * Abbreviates common key names to single/double letters
 * 
 * Token savings: ~20-40% on JSON with many keys
 */
export function applyRTK(obj: unknown): unknown {
  if (!obj || typeof obj !== "object") return obj;
  
  if (Array.isArray(obj)) {
    return obj.map(item => applyRTK(item));
  }
  
  const compressed: Record<string, unknown> = {};
  const original = obj as Record<string, unknown>;
  
  for (const [key, value] of Object.entries(original)) {
    const shortKey = RTK_KEY_MAP[key] || key;
    compressed[shortKey] = typeof value === "object" ? applyRTK(value) : value;
  }
  
  return compressed;
}

/**
 * Reverse RTK compression
 */
export function reverseRTK(obj: unknown): unknown {
  if (!obj || typeof obj !== "object") return obj;
  
  if (Array.isArray(obj)) {
    return obj.map(item => reverseRTK(item));
  }
  
  const decompressed: Record<string, unknown> = {};
  const compressed = obj as Record<string, unknown>;
  
  for (const [key, value] of Object.entries(compressed)) {
    const fullKey = RTK_REVERSE_MAP[key] || key;
    decompressed[fullKey] = typeof value === "object" ? reverseRTK(value) : value;
  }
  
  return decompressed;
}

// ----- Caveman Compression -----

/**
 * Compress text to "caveman speak" - ultra-minimal English
 * Removes articles, prepositions, auxiliary verbs, etc.
 * 
 * Token savings: ~30-50% on natural language text
 * 
 * Example:
 *   "The user needs to fix the bug in the system"
 *   → "user fix bug system"
 */
export function compressCaveman(text: string): string {
  if (!text || text.length < 50) return text;
  
  let compressed = text;
  
  // Remove articles
  compressed = compressed.replace(/\b(the|a|an)\b/gi, "");
  
  // Remove common prepositions
  compressed = compressed.replace(/\b(in|on|at|to|for|of|with|from|by|about)\b/gi, "");
  
  // Remove auxiliary verbs
  compressed = compressed.replace(/\b(is|are|was|were|be|been|being|am)\b/gi, "");
  compressed = compressed.replace(/\b(has|have|had|do|does|did|will|would|should|could|can|may|might)\b/gi, "");
  
  // Remove pronouns (keep "I" and "you" for clarity)
  compressed = compressed.replace(/\b(he|she|it|they|them|their|his|her|its)\b/gi, "");
  
  // Remove common conjunctions
  compressed = compressed.replace(/\b(and|or|but|so|yet|nor)\b/gi, "");
  
  // Remove "to" before verbs (infinitive marker)
  compressed = compressed.replace(/\bto\s+(\w+)/gi, "$1");
  
  // Remove possessive 's
  compressed = compressed.replace(/'s\b/g, "");
  
  // Remove punctuation except periods and commas (keep some structure)
  compressed = compressed.replace(/[?!;:()]/g, "");
  
  // Collapse multiple spaces
  compressed = compressed.replace(/\s+/g, " ");
  
  // Remove leading/trailing spaces
  compressed = compressed.trim();
  
  return compressed;
}

// ----- Varman-style Compression -----

/**
 * Compress verbose text using Varman-style markdown condensation
 * Removes filler words, redundancy, and verbose formatting
 * 
 * Token savings: ~20-40% on verbose text
 */
export function compressVarman(text: string): string {
  if (!text || text.length < 100) return text;
  
  let compressed = text;
  
  // Remove common filler phrases
  const fillers = [
    /\b(I think that|I believe that|It seems that|It appears that)\b/gi,
    /\b(In my opinion|In my view|From my perspective)\b/gi,
    /\b(As you can see|As mentioned|As stated)\b/gi,
    /\b(Please note that|It should be noted that)\b/gi,
    /\b(In order to|For the purpose of)\b/gi,
    /\b(Due to the fact that|Owing to the fact that)\b/gi,
  ];
  
  fillers.forEach(pattern => {
    compressed = compressed.replace(pattern, "");
  });
  
  // Compress common phrases
  const replacements: [RegExp, string][] = [
    [/in order to/gi, "to"],
    [/due to the fact that/gi, "because"],
    [/at this point in time/gi, "now"],
    [/in the event that/gi, "if"],
    [/for the purpose of/gi, "for"],
    [/with regard to/gi, "about"],
    [/in the process of/gi, ""],
  ];
  
  replacements.forEach(([pattern, replacement]) => {
    compressed = compressed.replace(pattern, replacement);
  });
  
  // Remove excessive whitespace
  compressed = compressed.replace(/\s+/g, " ");
  compressed = compressed.replace(/\n\s*\n\s*\n/g, "\n\n");
  
  return compressed.trim();
}

/**
 * Compression options for tool results
 */
export interface CompressionOptions {
  /** Use TOON (columnar format) for structured data */
  useTOON?: boolean;
  /** Use RTK (reduced token keys) for JSON */
  useRTK?: boolean;
  /** Use Caveman compression for text */
  useCaveman?: boolean;
  /** Use Varman compression for text (default) */
  useVarman?: boolean;
}

/**
 * Compress tool result for token efficiency
 * Supports multiple compression techniques
 */
export function compressToolResult(
  result: unknown,
  options: CompressionOptions = {}
): string {
  if (!result) return "";
  
  const {
    useTOON = true,
    useRTK = false,
    useCaveman = false,
    useVarman = true,
  } = options;
  
  // Try TOON for arrays and objects (if enabled)
  if (useTOON && (Array.isArray(result) || (typeof result === "object" && result !== null))) {
    try {
      // Apply RTK first if enabled (compress keys before TOON)
      const processed = useRTK ? applyRTK(result) : result;
      const toon = toTOON(processed);
      
      // Only use TOON if it's actually shorter
      const jsonStr = JSON.stringify(result);
      if (toon.length < jsonStr.length * 0.8) {
        const prefix = useRTK ? "[RTK+TOON]" : "[TOON]";
        return `${prefix}\n${toon}`;
      }
    } catch {
      // Fall through to other methods
    }
  }
  
  // Apply RTK to JSON (if enabled and not already done)
  if (useRTK && !useTOON && (typeof result === "object" && result !== null)) {
    try {
      const compressed = applyRTK(result);
      return `[RTK]\n${JSON.stringify(compressed)}`;
    } catch {
      // Fall through
    }
  }
  
  // Convert to text
  const text = typeof result === "string" ? result : JSON.stringify(result);
  
  // Apply text compression
  if (useCaveman && text.length > 50) {
    return `[CAVEMAN]\n${compressCaveman(text)}`;
  }
  
  if (useVarman && text.length > 100) {
    return compressVarman(text);
  }
  
  return text;
}

/**
 * Estimate token savings from compression
 */
export function estimateTokenSavings(original: string, compressed: string): number {
  // Rough estimate: 1 token ≈ 4 characters
  const originalTokens = Math.ceil(original.length / 4);
  const compressedTokens = Math.ceil(compressed.length / 4);
  const saved = originalTokens - compressedTokens;
  const percentage = Math.round((saved / originalTokens) * 100);
  
  return percentage;
}
