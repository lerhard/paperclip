/**
 * Token compression for tool results.
 * TOON (pipe-separated columns) + RTK (reduced token keys).
 */

/**
 * Convert JSON arrays/objects to TOON (Token-Efficient Columnar Notation).
 * Arrays of objects → header|row1|row2...
 * Single object   → key:value|key:value
 * Token savings: ~40-60% on arrays of objects.
 */
export function toTOON(data: unknown): string {
  if (data == null) return "";

  // Array of objects
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object" && data[0] !== null) {
    const objects = data as Record<string, unknown>[];
    const keys = Object.keys(objects[0]);
    if (keys.length === 0) return "";
    const header = keys.join("|");
    const rows = objects.map((obj) =>
      keys
        .map((k) => {
          const val = obj[k];
          if (val === null || val === undefined) return "";
          if (typeof val === "object") return JSON.stringify(val);
          return String(val).replace(/\|/g, "\\|");
        })
        .join("|"),
    );
    return [header, ...rows].join("\n");
  }

  // Single object
  if (typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    return Object.entries(obj)
      .map(([k, v]) => {
        if (v === null || v === undefined) return `${k}:`;
        if (typeof v === "object") return `${k}:${JSON.stringify(v)}`;
        return `${k}:${String(v).replace(/\|/g, "\\|")}`;
      })
      .join("|");
  }

  return String(data);
}

/** Abbreviate common JSON keys to reduce token count (~20-40%). */
const RTK_KEY_MAP: Record<string, string> = {
  id: "i",
  name: "n",
  title: "t",
  description: "d",
  content: "c",
  status: "s",
  type: "ty",
  error: "e",
  message: "m",
  result: "r",
  data: "da",
  url: "u",
  path: "p",
  value: "v",
  count: "co",
  total: "to",
  items: "it",
  files: "f",
  lines: "li",
  diff: "di",
  output: "o",
  input: "in",
  model: "mo",
  created: "cr",
  updated: "up",
  author: "au",
  assignee: "as",
  labels: "la",
  number: "no",
  state: "st",
  body: "b",
  comment: "cm",
};

function applyRTK(obj: unknown): unknown {
  if (obj == null) return obj;
  if (Array.isArray(obj)) return obj.map(applyRTK);
  if (typeof obj !== "object") return obj;
  const entries = Object.entries(obj as Record<string, unknown>);
  const compressed: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    const short = RTK_KEY_MAP[k] ?? k;
    compressed[short] = applyRTK(v);
  }
  return compressed;
}

/** Try TOON first; if not applicable, apply RTK + stringify. */
export function compressResult(data: unknown): string {
  const toon = toTOON(data);
  if (toon.length > 0) return toon;
  // Fallback: RTK-compressed JSON
  const rtk = applyRTK(data);
  return JSON.stringify(rtk);
}
