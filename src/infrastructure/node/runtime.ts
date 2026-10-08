import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import type {
  IAsyncContext,
  IClock,
  IIdGenerator,
  ILogger,
  IRandom,
  IRuntimeInfo,
} from "../../application/ports";

export const systemClock: IClock = { now: () => Date.now() };

export const cryptoIds: IIdGenerator = { uuid: () => randomUUID() };

export const mathRandom: IRandom = { next: () => Math.random() };

export function createAsyncContext<T>(): IAsyncContext<T> {
  return new AsyncLocalStorage<T>();
}

type ConsoleMethod = (...args: unknown[]) => void;

/**
 * Logs only when `debug` is true. Captures the original console methods at construction so
 * the console-breadcrumb integration never records (or loops on) SDK logs.
 */
export class ConsoleLogger implements ILogger {
  private readonly out: { log: ConsoleMethod; warn: ConsoleMethod; error: ConsoleMethod };

  constructor(private readonly enabled: boolean) {
    this.out = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.enabled) this.safe(this.out.log, message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.enabled) this.safe(this.out.warn, message, args);
  }

  error(message: string, ...args: unknown[]): void {
    if (this.enabled) this.safe(this.out.error, message, args);
  }

  private safe(fn: ConsoleMethod, message: string, args: unknown[]): void {
    try {
      fn(`[faultline] ${message}`, ...args);
    } catch {
      /* never throw from logging */
    }
  }
}

export const nodeRuntimeInfo: IRuntimeInfo = {
  contexts() {
    return {
      runtime: { name: "node", version: process.version },
      os: { name: safe(() => os.type(), "unknown"), version: safe(() => os.release(), undefined) },
    };
  },
  serverName() {
    return safe(() => os.hostname(), undefined);
  },
};

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
