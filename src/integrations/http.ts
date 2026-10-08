import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import type { Hub, Integration } from "../application/hub";
import type { Level, Scope } from "../domain";

type AnyFn = (...args: unknown[]) => unknown;
type Patched = {
  target: Record<string, unknown>;
  key: string;
  original: unknown;
  wrapped: unknown;
};

const SDK_HEADER = "x-faultline-key";

function levelFor(status: number | undefined): Level {
  if (status === undefined) return "error";
  if (status >= 500) return "error";
  if (status >= 400) return "warning";
  return "info";
}

/**
 * Outgoing http/https/fetch calls become "http" breadcrumbs. Instrumentation is passive:
 * original functions are always called with the same arguments and their return values are
 * returned untouched; we only listen to 'close' (which never changes stream semantics).
 * Requests to the SDK's own ingest endpoint (or carrying X-Faultline-Key) are never recorded.
 */
export class HttpIntegration implements Integration {
  readonly name = "http";
  private patched: Patched[] = [];

  constructor(private readonly options: { fetch?: boolean; http?: boolean } = {}) {}

  setup(hub: Hub): void {
    if (this.options.http !== false) {
      for (const mod of [http, https] as unknown as Record<string, unknown>[]) {
        this.patch(mod, "request", (original) => this.wrapRequest(hub, original));
        this.patch(mod, "get", (original) => this.wrapRequest(hub, original));
      }
      try {
        syncBuiltinESMExports();
      } catch {
        /* ESM named exports stay unpatched; default/CJS consumers still covered */
      }
    }
    if (this.options.fetch !== false && typeof globalThis.fetch === "function") {
      this.patch(globalThis, "fetch", (original) => this.wrapFetch(hub, original));
    }
  }

  teardown(): void {
    for (const p of this.patched.splice(0).reverse()) {
      if (p.target[p.key] === p.wrapped) p.target[p.key] = p.original;
    }
    try {
      syncBuiltinESMExports();
    } catch {
      /* ignore */
    }
  }

  private patch(
    target: Record<string, unknown>,
    key: string,
    make: (original: AnyFn) => AnyFn,
  ): void {
    const original = target[key];
    if (typeof original !== "function") return;
    const wrapped = make(original as AnyFn);
    try {
      Object.defineProperty(wrapped, "name", { value: (original as AnyFn).name });
    } catch {
      /* cosmetic only */
    }
    target[key] = wrapped;
    this.patched.push({ target, key, original, wrapped });
  }

  private wrapRequest(hub: Hub, original: AnyFn): AnyFn {
    return function (this: unknown, ...args: unknown[]): unknown {
      const req = original.apply(this, args);
      try {
        instrumentClientRequest(hub, req as http.ClientRequest);
      } catch {
        /* instrumentation must never break the request */
      }
      return req;
    };
  }

  private wrapFetch(hub: Hub, original: AnyFn): AnyFn {
    return function (this: unknown, ...args: unknown[]): unknown {
      const result = original.apply(this, args);
      let info: { method: string; url: string; scope: Scope } | undefined;
      try {
        info = describeFetch(hub, args[0], args[1]);
      } catch {
        info = undefined;
      }
      if (!info || !(result instanceof Promise)) return result;
      const { method, url, scope } = info;
      return result.then(
        (res: unknown) => {
          try {
            const status = (res as { status?: number }).status;
            hub.addBreadcrumb(
              {
                type: "http",
                category: "fetch",
                level: levelFor(status),
                data: { method, url, status_code: status },
              },
              scope,
            );
          } catch {
            /* ignore */
          }
          return res;
        },
        (err: unknown) => {
          try {
            hub.addBreadcrumb(
              {
                type: "http",
                category: "fetch",
                level: "error",
                data: { method, url, error: err instanceof Error ? err.message : String(err) },
              },
              scope,
            );
          } catch {
            /* ignore */
          }
          throw err;
        },
      );
    };
  }
}

function isOwnRequest(hub: Hub, url: string): boolean {
  const client = hub.getClient();
  return client ? client.isIngestUrl(url) : false;
}

function instrumentClientRequest(hub: Hub, req: http.ClientRequest): void {
  if (typeof (req as { on?: unknown } | undefined)?.on !== "function") return;
  if (req.getHeader(SDK_HEADER) !== undefined) return;
  const hostHeader = req.getHeader("host");
  const host = typeof hostHeader === "string" ? hostHeader : req.host;
  const url = `${req.protocol}//${host}${req.path}`;
  if (isOwnRequest(hub, url)) return;
  const method = req.method;
  const scope = hub.getScope(); // capture now: 'close' may fire in a pooled socket's async context
  req.on("close", () => {
    try {
      const status = (req as { res?: { statusCode?: number } }).res?.statusCode;
      hub.addBreadcrumb(
        {
          type: "http",
          category: "http",
          level: levelFor(status),
          data: { method, url, status_code: status },
        },
        scope,
      );
    } catch {
      /* ignore */
    }
  });
}

function describeFetch(
  hub: Hub,
  input: unknown,
  init: unknown,
): { method: string; url: string; scope: Scope } | undefined {
  let url: string;
  let method = "GET";
  let headers: unknown;
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.toString();
  else if (input && typeof input === "object" && typeof (input as Request).url === "string") {
    url = (input as Request).url;
    method = (input as Request).method || method;
    headers = (input as Request).headers;
  } else return undefined;

  if (init && typeof init === "object") {
    const i = init as RequestInit;
    if (typeof i.method === "string") method = i.method.toUpperCase();
    if (i.headers) headers = i.headers;
  }
  if (hasSdkHeader(headers) || isOwnRequest(hub, url)) return undefined;
  return { method, url, scope: hub.getScope() };
}

function hasSdkHeader(headers: unknown): boolean {
  if (!headers) return false;
  if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.has(SDK_HEADER);
  if (Array.isArray(headers)) {
    return headers.some((h) => Array.isArray(h) && String(h[0]).toLowerCase() === SDK_HEADER);
  }
  if (typeof headers === "object") {
    return Object.keys(headers).some((k) => k.toLowerCase() === SDK_HEADER);
  }
  return false;
}
