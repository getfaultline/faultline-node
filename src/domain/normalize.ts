/**
 * Converts arbitrary user-supplied values into JSON-safe data: handles cycles, BigInt,
 * functions, symbols, Errors, Dates, Maps/Sets and caps depth/breadth so a single
 * `extra` blob can never blow up serialization.
 */
export function toJsonSafe(value: unknown, maxDepth = 6, maxBreadth = 200): unknown {
  const seen = new WeakSet();

  const walk = (v: unknown, depth: number): unknown => {
    if (v === null) return null;
    switch (typeof v) {
      case "string":
        return v.length > 8192 ? v.slice(0, 8191) + "…" : v;
      case "number":
        return Number.isFinite(v) ? v : String(v);
      case "boolean":
        return v;
      case "bigint":
        return `${v.toString()}n`;
      case "undefined":
        return undefined;
      case "symbol":
        return v.toString();
      case "function":
        return `[Function: ${v.name || "anonymous"}]`;
      default:
        break;
    }
    const obj = v;
    if (seen.has(obj)) return "[Circular]";
    if (depth >= maxDepth) return Array.isArray(obj) ? "[Array]" : "[Object]";
    seen.add(obj);
    try {
      if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString();
      if (obj instanceof Error) {
        return { name: obj.name, message: obj.message, stack: obj.stack };
      }
      if (obj instanceof RegExp) return obj.toString();
      if (obj instanceof Map) {
        const out: Record<string, unknown> = {};
        let i = 0;
        for (const [k, val] of obj) {
          if (i++ >= maxBreadth) break;
          out[String(k)] = walk(val, depth + 1);
        }
        return out;
      }
      if (obj instanceof Set) return walk([...obj], depth);
      if (Array.isArray(obj)) {
        return obj.slice(0, maxBreadth).map((item) => {
          const r = walk(item, depth + 1);
          return r === undefined ? null : r;
        });
      }
      if (ArrayBuffer.isView(obj)) return `[${obj.constructor.name}]`;
      const out: Record<string, unknown> = {};
      let i = 0;
      for (const key of Object.keys(obj)) {
        if (i++ >= maxBreadth) break;
        let item: unknown;
        try {
          item = (obj as Record<string, unknown>)[key];
        } catch {
          item = "[Getter threw]";
        }
        const r = walk(item, depth + 1);
        if (r !== undefined) out[key] = r;
      }
      return out;
    } finally {
      seen.delete(obj);
    }
  };

  return walk(value, 0);
}

export function toJsonSafeRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const r = toJsonSafe(value);
  return r !== null && typeof r === "object" && !Array.isArray(r)
    ? (r as Record<string, unknown>)
    : undefined;
}

/** Coerces a record's values to strings (for headers / query / tags). */
export function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.map((x) => stringify(x)).join(", ");
    else out[k] = stringify(v);
  }
  return out;
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  try {
    return JSON.stringify(toJsonSafe(v)) ?? "";
  } catch {
    return "";
  }
}
