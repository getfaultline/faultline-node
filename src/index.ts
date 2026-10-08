/**
 * Public API and composition root. This is the only module that wires application,
 * infrastructure and integrations together. Every exported function is exception-safe:
 * the SDK never throws into the host application.
 */
import { FaultlineClient } from "./application/client";
import type { BreadcrumbInput, Integration } from "./application/hub";
import { Hub } from "./application/hub";
import type { CaptureContext, FaultlineOptions, Level, Scope, User } from "./domain";
import { isLevel, resolveOptions } from "./domain";
import {
  ConsoleLogger,
  FsSourceContextReader,
  HttpTransport,
  V8StackParser,
  createAsyncContext,
  cryptoIds,
  mathRandom,
  nodeRuntimeInfo,
  systemClock,
} from "./infrastructure";
import { ConsoleIntegration } from "./integrations/console";
import type {
  ErrorHandlerOptions,
  FaultlineErrorHandler,
  FaultlineRequestHandler,
  RequestHandlerOptions,
} from "./integrations/express";
import { createExpressHandlers } from "./integrations/express";
import { HttpIntegration } from "./integrations/http";
import { ProcessIntegration } from "./integrations/process";

declare const __SDK_VERSION__: string;
export const SDK_VERSION: string = typeof __SDK_VERSION__ === "string" ? __SDK_VERSION__ : "0.0.0";

export type {
  Breadcrumb,
  BreadcrumbType,
  BeforeSend,
  CaptureContext,
  ExceptionPayload,
  FaultlineEvent,
  FaultlineOptions,
  IntegrationToggles,
  Level,
  RequestData,
  StackFrame,
  User,
} from "./domain";
export { Scope } from "./domain";
export type { BreadcrumbInput } from "./application/hub";
export type {
  ErrorHandlerOptions,
  FaultlineErrorHandler,
  FaultlineRequestHandler,
  RequestHandlerOptions,
  RequestLike,
  ResponseLike,
  NextFunction,
} from "./integrations/express";

// One hub per process, shared between the ESM and CJS builds if both get loaded.
const HUB_KEY = Symbol.for("@faultline/node.hub");
function getHub(): Hub {
  const g = globalThis as unknown as Record<symbol, Hub | undefined>;
  let hub = g[HUB_KEY];
  if (!hub) {
    hub = new Hub(createAsyncContext<Scope>());
    g[HUB_KEY] = hub;
  }
  return hub;
}

const toStr = (v: unknown): string => (typeof v === "string" ? v : String(v));

function guard<T>(fallback: T, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    try {
      getHub().logger.error("internal SDK error", err);
    } catch {
      /* ignore */
    }
    return fallback;
  }
}

/** Initializes the SDK. Calling it again replaces the previous client. Never throws. */
export function init(options: FaultlineOptions): void {
  guard(undefined, () => {
    const hub = getHub();
    const previous = hub.getClient();
    hub.teardownIntegrations();
    hub.bindClient(undefined);
    if (previous) void previous.close(2000);

    const result = resolveOptions(options);
    const logger = new ConsoleLogger(result.ok ? result.options.debug : result.debug);
    for (const w of result.warnings) logger.warn(`invalid option: ${w}`);
    if (!result.ok) {
      logger.error(`SDK disabled: ${result.errors.join("; ")}`);
      return;
    }
    const opts = result.options;
    if (!opts.enabled) {
      logger.debug("SDK disabled (enabled: false)");
      return;
    }

    // Transport is created before integrations so it captures the un-instrumented fetch.
    const transport = new HttpTransport({ endpoint: opts.endpoint, apiKey: opts.apiKey, logger });
    const client = new FaultlineClient(opts, {
      transport,
      stackParser: new V8StackParser(),
      sourceReader: new FsSourceContextReader(),
      clock: systemClock,
      ids: cryptoIds,
      random: mathRandom,
      logger,
      runtime: nodeRuntimeInfo,
      sdkVersion: SDK_VERSION,
    });
    hub.bindClient(client);

    const integrations: Integration[] = [];
    if (opts.integrations.process) integrations.push(new ProcessIntegration());
    if (opts.integrations.console) integrations.push(new ConsoleIntegration());
    if (opts.integrations.http) integrations.push(new HttpIntegration());
    hub.installIntegrations(integrations);
    logger.debug(`initialized (endpoint ${opts.endpoint}, sdk ${SDK_VERSION})`);
  });
}

/** Captures an exception (or any thrown value). Returns the event id, or undefined if dropped/disabled. */
export function captureException(exception: unknown, context?: CaptureContext): string | undefined {
  return guard(undefined, () => {
    let syntheticStack: string | undefined;
    if (!(exception instanceof Error)) {
      const holder: { stack?: string } = {};
      Error.captureStackTrace(holder, captureException);
      syntheticStack = holder.stack;
    }
    const hint = context && typeof context === "object" ? { ...context } : {};
    return getHub().captureException(exception, { ...hint, syntheticStack });
  });
}

/** Captures a plain message. `level` defaults to "info". */
export function captureMessage(
  message: string,
  level?: Level | CaptureContext,
): string | undefined {
  return guard(undefined, () => {
    if (isLevel(level)) return getHub().captureMessage(message, level);
    const ctx = level && typeof level === "object" ? level : undefined;
    return getHub().captureMessage(message, ctx?.level, ctx);
  });
}

export function setUser(user: User | null): void {
  guard(undefined, () => getHub().setUser(user && typeof user === "object" ? user : null));
}

export function setTag(key: string, value: string): void {
  guard(undefined, () => {
    if (typeof key === "string") getHub().setTag(key, toStr(value));
  });
}

export function setTags(tags: Record<string, string>): void {
  guard(undefined, () => {
    if (!tags || typeof tags !== "object") return;
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(tags)) clean[k] = toStr(v);
    getHub().setTags(clean);
  });
}

export function setContext(name: string, context: Record<string, unknown> | null): void {
  guard(undefined, () => {
    if (typeof name !== "string") return;
    getHub().setContext(name, context && typeof context === "object" ? context : null);
  });
}

export function setExtra(key: string, value: unknown): void {
  guard(undefined, () => {
    if (typeof key === "string") getHub().setExtra(key, value);
  });
}

export function addBreadcrumb(breadcrumb: BreadcrumbInput): void {
  guard(undefined, () => {
    if (breadcrumb && typeof breadcrumb === "object") getHub().addBreadcrumb(breadcrumb);
  });
}

/**
 * Runs `callback` with a forked scope; changes made to `scope` only apply inside it
 * (including async work it starts). Errors thrown by `callback` itself propagate as usual.
 */
export function withScope<R>(callback: (scope: Scope) => R): R | undefined {
  if (typeof callback !== "function") return undefined;
  let hub: Hub;
  try {
    hub = getHub();
  } catch {
    return undefined;
  }
  return hub.withScope(callback);
}

/** Waits until queued events are sent. Resolves false on timeout. Never rejects. */
export async function flush(timeoutMs = 2000): Promise<boolean> {
  try {
    return await getHub().flush(timeoutMs);
  } catch {
    return false;
  }
}

/** Flushes, removes integrations and disables the SDK. Never rejects. */
export async function close(timeoutMs = 2000): Promise<boolean> {
  try {
    return await getHub().close(timeoutMs);
  } catch {
    return false;
  }
}

/** True when `init` succeeded and the SDK is sending events. */
export function isEnabled(): boolean {
  return guard(false, () => getHub().getClient()?.isEnabled ?? false);
}

const passThrough: FaultlineRequestHandler = (_req, _res, next) => next();
const passThroughError: FaultlineErrorHandler = (err, _req, _res, next) => next(err);

/** Express (4/5-compatible) middleware. */
export const Handlers = {
  requestHandler(options?: RequestHandlerOptions): FaultlineRequestHandler {
    return guard(passThrough, () => createExpressHandlers(getHub()).requestHandler(options));
  },
  errorHandler(options?: ErrorHandlerOptions): FaultlineErrorHandler {
    return guard(passThroughError, () => createExpressHandlers(getHub()).errorHandler(options));
  },
};
