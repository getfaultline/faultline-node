import type { Hub } from "../application/hub";
import type { RequestData } from "../domain";
import { toStringRecord } from "../domain";

/** Structural request type: works with Express 4/5 (and plain node:http + extras) without importing express. */
export interface RequestLike {
  method?: string;
  url?: string;
  originalUrl?: string;
  protocol?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: unknown;
  ip?: string;
  socket?: { remoteAddress?: string };
}

export interface ResponseLike {
  statusCode?: number;
  locals?: Record<string, unknown>;
}

export type NextFunction = (err?: unknown) => void;

export interface RequestHandlerOptions {
  /** Add a breadcrumb for the incoming request. Default true. */
  breadcrumb?: boolean;
}

export interface ErrorHandlerOptions {
  /** Decide which errors are captured. Default: status ≥ 500 (or no status). */
  shouldHandleError?: (error: unknown) => boolean;
}

export type FaultlineRequestHandler = (
  req: RequestLike,
  res: ResponseLike,
  next: NextFunction,
) => void;
export type FaultlineErrorHandler = (
  err: unknown,
  req: RequestLike,
  res: ResponseLike,
  next: NextFunction,
) => void;

export function extractRequest(req: RequestLike): RequestData {
  const data: RequestData = {};
  if (typeof req.method === "string") data.method = req.method;
  const path = req.originalUrl ?? req.url;
  if (typeof path === "string") {
    const hostHeader = req.headers?.host;
    const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    const protocol = typeof req.protocol === "string" ? req.protocol : "http";
    data.url = host ? `${protocol}://${host}${path}` : path;
  }
  const headers = toStringRecord(req.headers);
  if (headers) data.headers = headers;
  let query = toStringRecord(req.query);
  if (!query && typeof path === "string" && path.includes("?")) {
    try {
      query = Object.fromEntries(new URLSearchParams(path.slice(path.indexOf("?") + 1)));
    } catch {
      query = undefined;
    }
  }
  if (query && Object.keys(query).length > 0) data.query = query;
  return data;
}

export function getStatusCode(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const e = error as Record<string, unknown>;
  const output = e.output as { statusCode?: unknown } | undefined;
  for (const candidate of [e.status, e.statusCode, e.status_code, output?.statusCode]) {
    const n = typeof candidate === "string" ? Number(candidate) : candidate;
    if (typeof n === "number" && Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  return undefined;
}

export function createExpressHandlers(hub: Hub) {
  const applyRequest = (req: RequestLike, scope: ReturnType<Hub["getScope"]>) => {
    scope.setRequest(extractRequest(req));
    if (hub.getClient()?.options.sendDefaultPii) {
      const ip = req.ip ?? req.socket?.remoteAddress;
      if (ip) scope.setUser({ ...scope.getData().user, ipAddress: ip });
    }
  };

  return {
    /** Forks a per-request scope (AsyncLocalStorage) and attaches request data + a breadcrumb. */
    requestHandler(options: RequestHandlerOptions = {}): FaultlineRequestHandler {
      return function faultlineRequestHandler(req, _res, next) {
        let called = false;
        const callNext = () => {
          called = true;
          next();
        };
        try {
          hub.runInNewScope((scope) => {
            try {
              applyRequest(req, scope);
              if (options.breadcrumb !== false) {
                hub.addBreadcrumb(
                  {
                    type: "http",
                    category: "request",
                    message: `${req.method ?? "GET"} ${req.originalUrl ?? req.url ?? "/"}`,
                    data: { method: req.method, url: req.originalUrl ?? req.url },
                  },
                  scope,
                );
              }
            } catch (err) {
              hub.logger.error("requestHandler failed to build scope", err);
            }
            callNext();
          });
        } catch (err) {
          if (called) throw err; // error came from downstream, not from us
          hub.logger.error("requestHandler failed", err);
          callNext();
        }
      };
    },

    /** Captures errors with status ≥ 500 (configurable) and passes them on unchanged. */
    errorHandler(options: ErrorHandlerOptions = {}): FaultlineErrorHandler {
      return function faultlineErrorHandler(err, req, res, next) {
        try {
          let handle: boolean;
          try {
            handle = options.shouldHandleError
              ? options.shouldHandleError(err)
              : (getStatusCode(err) ?? 500) >= 500;
          } catch (e) {
            hub.logger.error("shouldHandleError threw", e);
            handle = true;
          }
          if (handle) {
            hub.withScope((scope) => {
              if (!scope.getData().request) applyRequest(req, scope);
              const eventId = hub.captureException(err, { tags: { mechanism: "express" } });
              if (eventId && res.locals && typeof res.locals === "object") {
                res.locals.faultlineEventId = eventId;
              }
            });
          }
        } catch (e) {
          hub.logger.error("errorHandler failed", e);
        }
        next(err);
      };
    },
  };
}
