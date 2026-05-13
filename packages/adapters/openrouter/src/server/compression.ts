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
 * Compress tool result for token efficiency
 * Uses TOON for structured data, Varman for text
 */
export function compressToolResult(result: unknown): string {
  if (!result) return "";
  
  // Try TOON for arrays and objects
  if (Array.isArray(result) || (typeof result === "object" && result !== null)) {
    try {
      const toon = toTOON(result);
      // Only use TOON if it's actually shorter
      const jsonStr = JSON.stringify(result);
      if (toon.length < jsonStr.length * 0.8) {
        return `[TOON]\n${toon}`;
      }
    } catch {
      // Fall through to string conversion
    }
  }
  
  // Use Varman for text
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return compressVarman(text);
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
