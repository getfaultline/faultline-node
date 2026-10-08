/** Limits pinned in CONTRACTS.md §2. Both SDK and server use these numbers. */
export const LIMITS = {
  maxBatchEvents: 50,
  maxBodyBytes: 1024 * 1024,
  maxTags: 50,
  maxTagKeyLength: 32,
  maxTagValueLength: 200,
  maxBreadcrumbs: 100,
  /** Total exception chain length: the root exception plus at most 4 causes (see ARCHITECTURE.md ADR-007). */
  maxExceptionDepth: 5,
  maxFrames: 100,
  maxMessageLength: 8192,
  contextLines: 5,
  maxContextLineLength: 300,
} as const;

export const ELLIPSIS = "…";

/** Truncates to at most `max` characters (including the trailing ellipsis). */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 0) return "";
  return value.slice(0, max - 1) + ELLIPSIS;
}
