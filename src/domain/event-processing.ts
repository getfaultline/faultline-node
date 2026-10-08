import type { Breadcrumb, ExceptionPayload, FaultlineEvent, StackFrame } from "./event";
import { SDK_NAME, isBreadcrumbType, isLevel } from "./event";
import { LIMITS, truncate } from "./limits";
import { toJsonSafe, toJsonSafeRecord, toStringRecord } from "./normalize";
import { FILTERED, PII_HEADERS, isSensitiveKey, scrubUrl, scrubValue } from "./scrub";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const optStr = (v: unknown, max: number = LIMITS.maxMessageLength): string | undefined =>
  typeof v === "string" ? truncate(v, max) : undefined;

const posInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;

function sanitizeLines(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v
    .filter((l): l is string => typeof l === "string")
    .slice(-LIMITS.contextLines)
    .map((l) => truncate(l, LIMITS.maxContextLineLength));
}

function sanitizeFrame(raw: unknown): StackFrame | undefined {
  if (!isRecord(raw)) return undefined;
  const filename =
    typeof raw.filename === "string" && raw.filename !== "" ? raw.filename : "<unknown>";
  const frame: StackFrame = { filename: truncate(filename, 1024), inApp: raw.inApp === true };
  const fn = optStr(raw.function, 1024);
  if (fn !== undefined) frame.function = fn;
  const mod = optStr(raw.module, 1024);
  if (mod !== undefined) frame.module = mod;
  const lineno = posInt(raw.lineno);
  if (lineno !== undefined) frame.lineno = lineno;
  const colno = posInt(raw.colno);
  if (colno !== undefined) frame.colno = colno;
  const pre = sanitizeLines(raw.preContext);
  if (pre) frame.preContext = pre;
  if (typeof raw.contextLine === "string") {
    frame.contextLine = truncate(raw.contextLine, LIMITS.maxContextLineLength);
  }
  const post = sanitizeLines(raw.postContext);
  if (post) frame.postContext = post.slice(0, LIMITS.contextLines);
  return frame;
}

function sanitizeException(raw: unknown, depth: number): ExceptionPayload | undefined {
  if (!isRecord(raw) || depth >= LIMITS.maxExceptionDepth) return undefined;
  const type = typeof raw.type === "string" && raw.type !== "" ? truncate(raw.type, 256) : "Error";
  const value = typeof raw.value === "string" ? truncate(raw.value, LIMITS.maxMessageLength) : "";
  const st = isRecord(raw.stacktrace) ? raw.stacktrace : {};
  const rawFrames = Array.isArray(st.frames) ? (st.frames as unknown[]) : [];
  const frames = rawFrames
    .slice(-LIMITS.maxFrames)
    .map(sanitizeFrame)
    .filter((f): f is StackFrame => f !== undefined);
  const out: ExceptionPayload = { type, value, stacktrace: { frames } };
  const cause = sanitizeException(raw.cause, depth + 1);
  if (cause) out.cause = cause;
  return out;
}

function sanitizeBreadcrumb(raw: unknown): Breadcrumb | undefined {
  if (!isRecord(raw)) return undefined;
  const crumb: Breadcrumb = {
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
    type: isBreadcrumbType(raw.type) ? raw.type : "default",
  };
  const category = optStr(raw.category, 256);
  if (category !== undefined) crumb.category = category;
  const message = optStr(raw.message);
  if (message !== undefined) crumb.message = message;
  if (isLevel(raw.level)) crumb.level = raw.level;
  const data = toJsonSafeRecord(raw.data);
  if (data) crumb.data = data;
  return crumb;
}

function sanitizeTags(raw: unknown): Record<string, string> | undefined {
  const rec = toStringRecord(raw);
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(rec)) {
    if (n >= LIMITS.maxTags) break;
    const key = k.slice(0, LIMITS.maxTagKeyLength);
    if (key === "") continue;
    out[key] = truncate(v, LIMITS.maxTagValueLength);
    n++;
  }
  return out;
}

/**
 * Coerces an event (possibly returned by a user's `beforeSend`) into a payload that satisfies
 * the contract: valid enums, required fields present, every pinned limit enforced.
 * Returns undefined when the input is not salvageable.
 */
export function sanitizeEvent(raw: unknown, sdkVersion: string): FaultlineEvent | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.eventId !== "string" || raw.eventId === "") return undefined;

  const event: FaultlineEvent = {
    eventId: raw.eventId,
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
    level: isLevel(raw.level) ? raw.level : "error",
    platform: "node",
    sdk: { name: SDK_NAME, version: sdkVersion },
  };
  const environment = optStr(raw.environment, 200);
  if (environment !== undefined) event.environment = environment;
  const release = optStr(raw.release, 200);
  if (release !== undefined) event.release = release;
  const serverName = optStr(raw.serverName, 200);
  if (serverName !== undefined) event.serverName = serverName;
  const message = optStr(raw.message);
  if (message !== undefined) event.message = message;

  const exception = sanitizeException(raw.exception, 0);
  if (exception) event.exception = exception;

  if (Array.isArray(raw.fingerprint)) {
    const fp = (raw.fingerprint as unknown[])
      .filter((x) => typeof x === "string" || typeof x === "number")
      .map((x) => truncate(String(x), 512));
    if (fp.length > 0) event.fingerprint = fp;
  }

  const tags = sanitizeTags(raw.tags);
  if (tags && Object.keys(tags).length > 0) event.tags = tags;

  if (isRecord(raw.user)) {
    const u = raw.user;
    const user: NonNullable<FaultlineEvent["user"]> = {};
    for (const key of ["id", "email", "username", "ipAddress"] as const) {
      const v = u[key];
      if (typeof v === "string") user[key] = truncate(v, 256);
      else if (typeof v === "number") user[key] = String(v);
    }
    if (Object.keys(user).length > 0) event.user = user;
  }

  if (isRecord(raw.request)) {
    const r = raw.request;
    const request: NonNullable<FaultlineEvent["request"]> = {};
    const method = optStr(r.method, 16);
    if (method !== undefined) request.method = method;
    const url = optStr(r.url, 4096);
    if (url !== undefined) request.url = url;
    const headers = toStringRecord(r.headers);
    if (headers) request.headers = headers;
    const query = toStringRecord(r.query);
    if (query) request.query = query;
    if (Object.keys(request).length > 0) event.request = request;
  }

  const contexts = toJsonSafeRecord(raw.contexts);
  if (contexts && Object.keys(contexts).length > 0) event.contexts = contexts;

  if (Array.isArray(raw.breadcrumbs)) {
    const crumbs = (raw.breadcrumbs as unknown[])
      .slice(-LIMITS.maxBreadcrumbs)
      .map(sanitizeBreadcrumb)
      .filter((b): b is Breadcrumb => b !== undefined);
    if (crumbs.length > 0) event.breadcrumbs = crumbs;
  }

  const extra = toJsonSafeRecord(raw.extra);
  if (extra && Object.keys(extra).length > 0) event.extra = extra;

  return event;
}

/**
 * Client-side scrubbing (CONTRACTS.md §2). Sensitive keys anywhere in request/extra/contexts/
 * breadcrumb data → "[Filtered]"; credit-card values in request/extra/breadcrumb data → "[Filtered]".
 * When `sendDefaultPii` is false, user IP and cookie/auth/forwarding headers are removed entirely.
 */
export function scrubEvent(event: FaultlineEvent, sendDefaultPii: boolean): FaultlineEvent {
  const out: FaultlineEvent = { ...event };
  const cc = { creditCards: true };

  if (out.request) {
    const req = { ...out.request };
    if (req.headers) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const lower = k.toLowerCase();
        if (!sendDefaultPii && (PII_HEADERS as readonly string[]).includes(lower)) continue;
        headers[k] = isSensitiveKey(k) ? FILTERED : v;
      }
      req.headers = headers;
    }
    if (req.query) req.query = scrubValue(req.query, cc) as Record<string, string>;
    if (req.url) req.url = scrubUrl(req.url);
    out.request = req;
  }

  if (out.user) {
    const user = { ...out.user };
    if (!sendDefaultPii) delete user.ipAddress;
    out.user = user;
    if (Object.keys(user).length === 0) delete out.user;
  }

  if (out.tags) {
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(out.tags)) tags[k] = isSensitiveKey(k) ? FILTERED : v;
    out.tags = tags;
  }

  if (out.extra) out.extra = scrubValue(out.extra, cc) as Record<string, unknown>;
  if (out.contexts) {
    out.contexts = scrubValue(out.contexts, { creditCards: false }) as FaultlineEvent["contexts"];
  }
  if (out.breadcrumbs) {
    out.breadcrumbs = out.breadcrumbs.map((b) =>
      b.data ? { ...b, data: scrubValue(b.data, cc) as Record<string, unknown> } : b,
    );
  }
  return out;
}

const encoder = new TextEncoder();
export const byteLength = (s: string): number => encoder.encode(s).length;

/**
 * Ensures the serialized event fits within `maxBytes`, trimming breadcrumbs, then source
 * context, then extra. Returns the serialized JSON, or undefined if it still does not fit.
 */
export function serializeWithinLimit(
  event: FaultlineEvent,
  maxBytes: number,
): { event: FaultlineEvent; json: string } | undefined {
  const attempt = (e: FaultlineEvent) => {
    const json = JSON.stringify(toJsonSafe(e, 32, 10_000));
    return byteLength(json) <= maxBytes ? { event: e, json } : undefined;
  };
  let current = event;
  const first = attempt(current);
  if (first) return first;

  current = { ...current };
  delete current.breadcrumbs;
  const second = attempt(current);
  if (second) return second;

  const stripContext = (ex: ExceptionPayload | undefined): ExceptionPayload | undefined =>
    ex
      ? {
          type: ex.type,
          value: ex.value,
          stacktrace: {
            frames: ex.stacktrace.frames.map(
              ({ preContext: _a, contextLine: _b, postContext: _c, ...f }) => f,
            ),
          },
          ...(ex.cause ? { cause: stripContext(ex.cause) } : {}),
        }
      : undefined;
  if (current.exception) current.exception = stripContext(current.exception);
  const third = attempt(current);
  if (third) return third;

  delete current.extra;
  return attempt(current);
}

/** Stable key used to detect identical consecutive events (client-side dedupe). */
export function dedupeKey(event: FaultlineEvent): string {
  if (event.fingerprint && event.fingerprint.length > 0) return `fp:${event.fingerprint.join("|")}`;
  const ex = event.exception;
  if (ex) {
    const frames = ex.stacktrace.frames
      .slice(-5)
      .map((f) => `${f.filename}:${f.function ?? "?"}:${f.lineno ?? 0}:${f.colno ?? 0}`)
      .join(",");
    return `ex:${ex.type}:${ex.value}:${frames}`;
  }
  return `msg:${event.level}:${event.message ?? ""}`;
}

/** `ignoreErrors` matching: strings are substring matches, RegExps are tested. */
export function matchesIgnoreErrors(
  event: FaultlineEvent,
  patterns: readonly (string | RegExp)[],
): boolean {
  if (patterns.length === 0) return false;
  const candidates: string[] = [];
  const ex = event.exception;
  if (ex) candidates.push(ex.type, ex.value, `${ex.type}: ${ex.value}`);
  else if (event.message) candidates.push(event.message);
  return patterns.some((p) =>
    candidates.some((c) => {
      if (typeof p === "string") return c.includes(p);
      p.lastIndex = 0;
      return p.test(c);
    }),
  );
}
