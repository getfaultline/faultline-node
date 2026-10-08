import type { Breadcrumb, CaptureContext, Level, User } from "../domain";
import { LIMITS, Scope, isBreadcrumbType, isLevel } from "../domain";
import type { CaptureHint, FaultlineClient } from "./client";
import type { IAsyncContext, ILogger } from "./ports";

/** An integration hooks into the host runtime and reports through the Hub. */
export interface Integration {
  readonly name: string;
  setup(hub: Hub): void;
  teardown?(): void;
}

export type BreadcrumbInput = Partial<Omit<Breadcrumb, "timestamp">> & { timestamp?: string };

const silentLogger: ILogger = { debug() {}, warn() {}, error() {} };

/**
 * Holds the current client and the scope stack. The root scope is global; `withScope` and
 * `runInNewScope` fork it into an AsyncLocalStorage-backed child so concurrent requests and
 * async continuations each see their own data.
 */
export class Hub {
  private client: FaultlineClient | undefined;
  private readonly rootScope = new Scope();
  private integrations: Integration[] = [];

  constructor(private readonly storage: IAsyncContext<Scope>) {}

  getClient(): FaultlineClient | undefined {
    return this.client;
  }

  get logger(): ILogger {
    return this.client?.logger ?? silentLogger;
  }

  bindClient(client: FaultlineClient | undefined): void {
    this.client = client;
  }

  /** The scope active in the current async context (or the global root scope). */
  getScope(): Scope {
    return this.storage.getStore() ?? this.rootScope;
  }

  getRootScope(): Scope {
    return this.rootScope;
  }

  /** Runs `callback` with a forked scope. Async work started inside keeps that scope. */
  withScope<R>(callback: (scope: Scope) => R): R {
    const scope = this.getScope().clone();
    return this.storage.run(scope, () => callback(scope));
  }

  /** Runs `callback` inside a fresh fork of the current scope (used per request). */
  runInNewScope<R>(callback: (scope: Scope) => R): R {
    return this.withScope(callback);
  }

  captureException(exception: unknown, hint?: CaptureHint): string | undefined {
    return this.client?.captureException(exception, hint, this.getScope().getData());
  }

  captureMessage(message: unknown, level?: Level, hint?: CaptureContext): string | undefined {
    return this.client?.captureMessage(message, level, hint, this.getScope().getData());
  }

  /** Adds a breadcrumb to `scope` (default: the current scope). */
  addBreadcrumb(input: BreadcrumbInput, scope: Scope = this.getScope()): void {
    const crumb: Breadcrumb = {
      timestamp: typeof input.timestamp === "string" ? input.timestamp : new Date().toISOString(),
      type: isBreadcrumbType(input.type) ? input.type : "default",
    };
    if (typeof input.category === "string") crumb.category = input.category;
    if (typeof input.message === "string") crumb.message = input.message;
    if (isLevel(input.level)) crumb.level = input.level;
    if (input.data && typeof input.data === "object") crumb.data = { ...input.data };
    const max = this.client?.options.maxBreadcrumbs ?? LIMITS.maxBreadcrumbs;
    scope.addBreadcrumb(crumb, max);
  }

  setUser(user: User | null): void {
    this.getScope().setUser(user);
  }

  setTag(key: string, value: string): void {
    this.getScope().setTag(key, value);
  }

  setTags(tags: Record<string, string>): void {
    this.getScope().setTags(tags);
  }

  setContext(name: string, context: Record<string, unknown> | null): void {
    this.getScope().setContext(name, context);
  }

  setExtra(key: string, value: unknown): void {
    this.getScope().setExtra(key, value);
  }

  installIntegrations(integrations: Integration[]): void {
    for (const integration of integrations) {
      try {
        integration.setup(this);
        this.integrations.push(integration);
        this.logger.debug(`integration "${integration.name}" installed`);
      } catch (err) {
        this.logger.error(`integration "${integration.name}" failed to install`, err);
      }
    }
  }

  teardownIntegrations(): void {
    for (const integration of this.integrations.splice(0)) {
      try {
        integration.teardown?.();
      } catch (err) {
        this.logger.error(`integration "${integration.name}" failed to tear down`, err);
      }
    }
  }

  async flush(timeoutMs?: number): Promise<boolean> {
    return this.client ? this.client.flush(timeoutMs) : true;
  }

  async close(timeoutMs?: number): Promise<boolean> {
    this.teardownIntegrations();
    const client = this.client;
    if (!client) return true;
    const ok = await client.close(timeoutMs);
    if (this.client === client) this.client = undefined;
    return ok;
  }
}
