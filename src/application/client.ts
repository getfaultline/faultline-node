import type {
  CaptureContext,
  ExceptionPayload,
  FaultlineEvent,
  Level,
  ResolvedOptions,
  ScopeData,
  StackFrame,
} from "../domain";
import {
  INGEST_PATH,
  LIMITS,
  SDK_NAME,
  dedupeKey,
  isLevel,
  matchesIgnoreErrors,
  sanitizeEvent,
  scrubEvent,
  toJsonSafe,
  truncate,
} from "../domain";
import type {
  IClock,
  IIdGenerator,
  ILogger,
  IRandom,
  IRuntimeInfo,
  ISourceContextReader,
  IStackParser,
  ITransport,
} from "./ports";

export interface ClientDeps {
  transport: ITransport;
  stackParser: IStackParser;
  sourceReader?: ISourceContextReader;
  clock: IClock;
  ids: IIdGenerator;
  random: IRandom;
  logger: ILogger;
  runtime: IRuntimeInfo;
  sdkVersion: string;
}

export interface CaptureHint extends CaptureContext {
  /** Stack captured at the public call site, used for non-Error throwables. */
  syntheticStack?: string;
}

const DEDUPE_WINDOW_MS = 1000;

/**
 * Builds events, applies scope data, sampling, ignoreErrors, dedupe, scrubbing and beforeSend,
 * then hands them to the transport. Every public method is exception-safe.
 */
export class FaultlineClient {
  private readonly pending = new Set<Promise<void>>();
  private last: { key: string; at: number } | undefined;
  private closed = false;

  constructor(
    readonly options: ResolvedOptions,
    private readonly deps: ClientDeps,
  ) {}

  get logger(): ILogger {
    return this.deps.logger;
  }

  get isEnabled(): boolean {
    return this.options.enabled && !this.closed;
  }

  captureException(
    exception: unknown,
    hint: CaptureHint | undefined,
    scope: ScopeData | undefined,
  ): string | undefined {
    try {
      if (!this.isEnabled) return undefined;
      const payload = this.buildException(exception, hint?.syntheticStack);
      const event = this.baseEvent(hint?.level ?? scope?.level ?? "error");
      event.exception = payload;
      event.message = payload.value;
      return this.process(event, hint, scope);
    } catch (err) {
      this.deps.logger.error("captureException failed", err);
      return undefined;
    }
  }

  captureMessage(
    message: unknown,
    level: Level | undefined,
    hint: CaptureContext | undefined,
    scope: ScopeData | undefined,
  ): string | undefined {
    try {
      if (!this.isEnabled) return undefined;
      const lvl = isLevel(level) ? level : (hint?.level ?? scope?.level ?? "info");
      const event = this.baseEvent(lvl);
      event.message = truncate(
        typeof message === "string" ? message : safeString(message),
        LIMITS.maxMessageLength,
      );
      return this.process(event, hint, scope);
    } catch (err) {
      this.deps.logger.error("captureMessage failed", err);
      return undefined;
    }
  }

  /** Waits for in-flight event processing, then flushes the transport. */
  async flush(timeoutMs = 2000): Promise<boolean> {
    try {
      const start = this.deps.clock.now();
      const drained = await withTimeout(
        Promise.allSettled([...this.pending]).then(() => true),
        timeoutMs,
      );
      const remaining = Math.max(0, timeoutMs - (this.deps.clock.now() - start));
      const flushed = await this.deps.transport.flush(remaining);
      return drained && flushed;
    } catch (err) {
      this.deps.logger.error("flush failed", err);
      return false;
    }
  }

  async close(timeoutMs = 2000): Promise<boolean> {
    try {
      const ok = await this.flush(timeoutMs);
      this.closed = true;
      await this.deps.transport.close(0);
      return ok;
    } catch (err) {
      this.deps.logger.error("close failed", err);
      this.closed = true;
      return false;
    }
  }

  /** True when `url` targets this client's own ingest endpoint (used to avoid self-instrumentation). */
  isIngestUrl(url: string): boolean {
    return url.startsWith(this.options.endpoint + INGEST_PATH);
  }

  // ---------------------------------------------------------------------------------------

  private baseEvent(level: Level): FaultlineEvent {
    const { options, runtime } = { options: this.options, runtime: this.deps.runtime };
    const event: FaultlineEvent = {
      eventId: this.deps.ids.uuid(),
      timestamp: new Date(this.deps.clock.now()).toISOString(),
      level,
      platform: "node",
      sdk: { name: SDK_NAME, version: this.deps.sdkVersion },
    };
    if (options.environment) event.environment = options.environment;
    if (options.release) event.release = options.release;
    const serverName = options.serverName ?? runtime.serverName();
    if (serverName) event.serverName = serverName;
    return event;
  }

  private process(
    event: FaultlineEvent,
    hint: CaptureContext | undefined,
    scope: ScopeData | undefined,
  ): string | undefined {
    const { options, logger } = { options: this.options, logger: this.deps.logger };

    if (options.sampleRate < 1 && this.deps.random.next() >= options.sampleRate) {
      logger.debug(`event ${event.eventId} dropped by sampleRate`);
      return undefined;
    }

    this.applyScope(event, hint, scope);

    if (matchesIgnoreErrors(event, options.ignoreErrors)) {
      logger.debug(`event ${event.eventId} dropped by ignoreErrors`);
      return undefined;
    }

    const key = dedupeKey(event);
    const now = this.deps.clock.now();
    if (this.last && this.last.key === key && now - this.last.at < DEDUPE_WINDOW_MS) {
      logger.debug(`event ${event.eventId} dropped as duplicate`);
      return undefined;
    }
    this.last = { key, at: now };

    const task = this.finish(event).catch((err: unknown) => {
      logger.error("event processing failed", err);
    });
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
    return event.eventId;
  }

  private applyScope(
    event: FaultlineEvent,
    hint: CaptureContext | undefined,
    scope: ScopeData | undefined,
  ): void {
    const runtimeContexts = this.deps.runtime.contexts();
    const tags = { ...scope?.tags, ...hint?.tags };
    if (Object.keys(tags).length > 0) event.tags = tags;

    const user = { ...scope?.user, ...hint?.user };
    if (Object.keys(user).length > 0) event.user = user;

    if (scope?.request) event.request = { ...scope.request };

    event.contexts = { ...runtimeContexts, ...scope?.contexts, ...hint?.contexts };

    const extra = { ...scope?.extra, ...hint?.extra };
    if (Object.keys(extra).length > 0) event.extra = extra;

    const crumbs = scope?.breadcrumbs ?? [];
    const max = this.options.maxBreadcrumbs;
    if (crumbs.length > 0 && max > 0) event.breadcrumbs = crumbs.slice(-max);

    const fingerprint = hint?.fingerprint ?? scope?.fingerprint;
    if (fingerprint && fingerprint.length > 0) event.fingerprint = [...fingerprint];
  }

  private async finish(event: FaultlineEvent): Promise<void> {
    const { logger } = this.deps;

    if (event.exception && this.deps.sourceReader) {
      await this.addContext(event.exception);
    }

    let prepared = sanitizeEvent(event, this.deps.sdkVersion);
    if (!prepared) return;
    prepared = scrubEvent(prepared, this.options.sendDefaultPii);

    const beforeSend = this.options.beforeSend;
    if (beforeSend) {
      let result: unknown;
      try {
        result = await beforeSend(prepared);
      } catch (err) {
        logger.warn(`beforeSend threw; event ${prepared.eventId} dropped`, err);
        return;
      }
      if (result === null || result === undefined) {
        logger.debug(`event ${prepared.eventId} dropped by beforeSend`);
        return;
      }
      const after = sanitizeEvent(result, this.deps.sdkVersion);
      if (!after) {
        logger.warn("beforeSend returned an invalid event; dropped");
        return;
      }
      prepared = after;
    }

    if (this.closed) return;
    this.deps.transport.send(prepared);
  }

  private async addContext(ex: ExceptionPayload): Promise<void> {
    const reader = this.deps.sourceReader;
    if (!reader) return;
    let current: ExceptionPayload | undefined = ex;
    while (current) {
      try {
        current.stacktrace.frames = await reader.addSourceContext(current.stacktrace.frames);
      } catch (err) {
        this.deps.logger.debug("source context failed", err);
      }
      current = current.cause;
    }
  }

  private buildException(exception: unknown, syntheticStack: string | undefined): ExceptionPayload {
    const seen = new Set<unknown>();
    const build = (value: unknown, depth: number): ExceptionPayload => {
      seen.add(value);
      let payload: ExceptionPayload;
      if (isErrorLike(value)) {
        payload = {
          type: errorType(value),
          value: truncate(safeString(value.message), LIMITS.maxMessageLength),
          stacktrace: { frames: this.parseStack(value.stack) },
        };
        const cause = (value as { cause?: unknown }).cause;
        if (
          cause !== undefined &&
          cause !== null &&
          depth + 1 < LIMITS.maxExceptionDepth &&
          !seen.has(cause)
        ) {
          payload.cause = build(cause, depth + 1);
        }
      } else {
        payload = {
          type: depth === 0 ? "Error" : "NonErrorCause",
          value: truncate(describeNonError(value), LIMITS.maxMessageLength),
          stacktrace: { frames: depth === 0 ? this.parseStack(syntheticStack) : [] },
        };
      }
      return payload;
    };
    return build(exception, 0);
  }

  private parseStack(stack: string | undefined): StackFrame[] {
    try {
      return this.deps.stackParser.parse(stack).slice(-LIMITS.maxFrames);
    } catch (err) {
      this.deps.logger.debug("stack parsing failed", err);
      return [];
    }
  }
}

interface ErrorLike {
  name?: unknown;
  message: unknown;
  stack?: string;
}

function isErrorLike(value: unknown): value is ErrorLike {
  if (value instanceof Error) return true;
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { message?: unknown }).message === "string" &&
    typeof (value as { stack?: unknown }).stack === "string"
  );
}

function errorType(err: ErrorLike): string {
  try {
    if (typeof err.name === "string" && err.name !== "") return err.name;
    const ctor = (err as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof ctor === "string" && ctor !== "") return ctor;
  } catch {
    /* fallthrough */
  }
  return "Error";
}

function safeString(value: unknown): string {
  try {
    if (typeof value === "string") return value;
    if (value === undefined) return "";
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- deliberate best-effort conversion
    return String(value);
  } catch {
    return "[unserializable]";
  }
}

/** Human-readable description of a thrown non-Error value (string, number, plain object…). */
export function describeNonError(value: unknown): string {
  try {
    if (typeof value === "string") return value;
    if (value === null || value === undefined || typeof value !== "object") {
      return `Non-Error thrown: ${typeof value === "symbol" ? value.toString() : String(value)}`;
    }
    const keys = Object.keys(value).slice(0, 10);
    const json = JSON.stringify(toJsonSafe(value, 3, 20));
    return `Non-Error object thrown with keys: ${keys.join(", ") || "(none)"}${json ? ` — ${truncate(json, 1024)}` : ""}`;
  } catch {
    return "Non-Error thrown";
  }
}

function withTimeout(promise: Promise<boolean>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, ms));
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}
