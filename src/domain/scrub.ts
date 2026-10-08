/**
 * Client-side PII scrubbing. Regexes are copied verbatim from CONTRACTS.md §2 so the SDK and
 * the server agree on what is sensitive.
 */

export const FILTERED = "[Filtered]";

export const SENSITIVE_KEY_REGEX =
  /(authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key|x-faultline-key)/i;

export const CREDIT_CARD_REGEX = /\b(?:\d[ -]*?){13,16}\b/;

/** Header names removed entirely when `sendDefaultPii` is false. */
export const PII_HEADERS = [
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
] as const;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_REGEX.test(key);
}

export function looksLikeCreditCard(value: string): boolean {
  return CREDIT_CARD_REGEX.test(value);
}

/** Replaces values of sensitive query parameters in a URL-ish string (`?token=abc` → `?token=[Filtered]`). */
export function scrubUrl(value: string): string {
  if (!value.includes("?") || !value.includes("=")) return value;
  return value.replace(/([?&])([^=&#]+)=([^&#]*)/g, (match, sep: string, key: string) => {
    let decoded = key;
    try {
      decoded = decodeURIComponent(key);
    } catch {
      /* keep raw key */
    }
    return isSensitiveKey(decoded) ? `${sep}${key}=${FILTERED}` : match;
  });
}

export interface ScrubOptions {
  /** Also replace string values that look like credit-card numbers. */
  creditCards: boolean;
}

/**
 * Deep-scrubs a JSON-safe value: values under sensitive keys become "[Filtered]";
 * optionally, credit-card-looking strings become "[Filtered]" and URLs get sensitive query params masked.
 * Returns a new value; never mutates the input.
 */
export function scrubValue(value: unknown, options: ScrubOptions, depth = 0): unknown {
  if (depth > 20) return value;
  if (typeof value === "string") {
    if (options.creditCards && looksLikeCreditCard(value)) return FILTERED;
    return options.creditCards ? scrubUrl(value) : value;
  }
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, options, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? FILTERED : scrubValue(v, options, depth + 1);
    }
    return out;
  }
  return value;
}

export function scrubRecord<T>(
  record: Record<string, T>,
  options: ScrubOptions,
): Record<string, T> {
  return scrubValue(record, options) as Record<string, T>;
}
