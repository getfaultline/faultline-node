import type { FaultlineEvent, StackFrame } from "../../domain";

/** Delivers events to the Faultline ingest API. Must never throw. */
export interface ITransport {
  /** Enqueue an event for delivery (non-blocking). */
  send(event: FaultlineEvent): void;
  /** Resolves true when everything queued so far was delivered (or dropped) within `timeoutMs`. */
  flush(timeoutMs?: number): Promise<boolean>;
  /** Flushes, then stops accepting events and releases timers. */
  close(timeoutMs?: number): Promise<boolean>;
}

/** Parses an `error.stack` string into frames ordered oldest → newest. Must never throw. */
export interface IStackParser {
  parse(stack: string | undefined): StackFrame[];
}

/** Adds pre/post/context lines to in-app frames. Must never throw (returns input on failure). */
export interface ISourceContextReader {
  addSourceContext(frames: StackFrame[]): Promise<StackFrame[]>;
}

export interface IClock {
  /** Epoch milliseconds. */
  now(): number;
}

export interface IIdGenerator {
  /** Lowercase uuid v4 with dashes. */
  uuid(): string;
}

export interface IRandom {
  /** Uniform in [0, 1). */
  next(): number;
}

export interface ILogger {
  debug(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** Minimal async-context storage (AsyncLocalStorage-compatible) so the Hub stays framework-free. */
export interface IAsyncContext<T> {
  getStore(): T | undefined;
  run<R>(store: T, callback: () => R): R;
}

/** Static environment facts attached to every event. */
export interface IRuntimeInfo {
  contexts(): {
    runtime: { name: string; version: string };
    os: { name: string; version?: string };
  };
  serverName(): string | undefined;
}
