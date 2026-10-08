import type { Hub, Integration } from "../application/hub";

type Listener = (...args: unknown[]) => void;

/** The subset of `process` used here — injectable for tests. */
export interface ProcessLike {
  on(event: string, listener: Listener): unknown;
  off(event: string, listener: Listener): unknown;
  listeners(event: string): unknown[];
  execArgv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number | string | null | undefined;
}

export interface ProcessIntegrationOptions {
  process?: ProcessLike;
  exit?: (code: number) => void;
  writeStderr?: (text: string) => void;
  flushTimeoutMs?: number;
}

type RejectionMode = "throw" | "strict" | "warn" | "none" | "warn-with-error-code";

/**
 * Captures uncaughtException / unhandledRejection, flushes, then reproduces Node's default
 * behavior (print + exit 1, or the configured --unhandled-rejections mode). If the app has its
 * own listeners, the app owns the exit decision and we only capture + flush.
 */
export class ProcessIntegration implements Integration {
  readonly name = "process";
  private proc: ProcessLike;
  private readonly exit: (code: number) => void;
  private readonly writeStderr: (text: string) => void;
  private readonly flushTimeoutMs: number;
  private hub: Hub | undefined;
  private exiting = false;

  constructor(options: ProcessIntegrationOptions = {}) {
    this.proc = options.process ?? process;
    this.exit = options.exit ?? ((code) => process.exit(code));
    this.writeStderr =
      options.writeStderr ??
      ((text) => {
        try {
          process.stderr.write(text);
        } catch {
          /* ignore */
        }
      });
    this.flushTimeoutMs = options.flushTimeoutMs ?? 2000;
  }

  setup(hub: Hub): void {
    this.hub = hub;
    this.proc.on("uncaughtException", this.onUncaughtException);
    this.proc.on("unhandledRejection", this.onUnhandledRejection);
  }

  teardown(): void {
    this.proc.off("uncaughtException", this.onUncaughtException);
    this.proc.off("unhandledRejection", this.onUnhandledRejection);
    this.hub = undefined;
  }

  private hasOtherListeners(event: string, self: Listener): boolean {
    try {
      return this.proc.listeners(event).some((l) => l !== self);
    } catch {
      return false;
    }
  }

  private readonly onUncaughtException = (error: unknown, origin?: unknown): void => {
    if (this.exiting) {
      // A second fatal error while we flush: report to stderr, the pending exit still happens.
      this.writeStderr(formatError(error));
      return;
    }
    const others = this.hasOtherListeners("uncaughtException", this.onUncaughtException);
    this.capture(
      error,
      "fatal",
      origin === "unhandledRejection" ? "onunhandledrejection" : "onuncaughtexception",
    );
    if (others) {
      void this.hub?.flush(this.flushTimeoutMs);
      return;
    }
    this.flushThenExit(error);
  };

  private readonly onUnhandledRejection = (reason: unknown): void => {
    const mode = rejectionMode(this.proc);
    // strict mode raises it as an uncaughtException first, which we already captured.
    if (mode === "strict") return;
    const others = this.hasOtherListeners("unhandledRejection", this.onUnhandledRejection);
    const willExit = !others && mode === "throw";
    this.capture(reason, willExit ? "fatal" : "error", "onunhandledrejection");
    if (others || mode === "none") {
      void this.hub?.flush(this.flushTimeoutMs);
      return;
    }
    if (mode === "warn" || mode === "warn-with-error-code") {
      this.writeStderr(`(node) UnhandledPromiseRejectionWarning: ${formatError(reason)}`);
      if (mode === "warn-with-error-code") this.proc.exitCode = 1;
      void this.hub?.flush(this.flushTimeoutMs);
      return;
    }
    if (this.exiting) return;
    this.flushThenExit(reason, true);
  };

  private capture(error: unknown, level: "fatal" | "error", mechanism: string): void {
    try {
      this.hub?.captureException(error, { level, tags: { mechanism, handled: "no" } });
    } catch {
      /* never throw from a process handler */
    }
  }

  private flushThenExit(error: unknown, rejection = false): void {
    this.exiting = true;
    const done = () => {
      this.writeStderr(rejection ? formatRejection(error) : formatError(error));
      this.exit(1);
    };
    const flush = this.hub?.flush(this.flushTimeoutMs) ?? Promise.resolve(true);
    flush.then(done, done);
  }
}

function rejectionMode(proc: ProcessLike): RejectionMode {
  const sources = [...proc.execArgv, proc.env.NODE_OPTIONS ?? ""].join(" ");
  const m = /--unhandled-rejections[= ]([a-z-]+)/.exec(sources);
  const mode = m?.[1];
  switch (mode) {
    case "strict":
    case "warn":
    case "none":
    case "warn-with-error-code":
    case "throw":
      return mode;
    default:
      return "throw";
  }
}

function formatError(error: unknown): string {
  try {
    if (error instanceof Error) return `${error.stack ?? `${error.name}: ${error.message}`}\n`;
    return `Uncaught ${typeof error === "string" ? `'${error}'` : String(error)}\n`;
  } catch {
    return "Uncaught exception\n";
  }
}

function formatRejection(reason: unknown): string {
  if (reason instanceof Error) return formatError(reason);
  let text: string;
  try {
    text = String(reason);
  } catch {
    text = "[unserializable]";
  }
  return (
    "[UnhandledPromiseRejection: This error originated either by throwing inside of an async " +
    "function without a catch block, or by rejecting a promise which was not handled with " +
    `.catch(). The promise rejected with the reason "${text}".]\n`
  );
}
