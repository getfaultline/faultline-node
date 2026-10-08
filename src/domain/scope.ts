import type { Breadcrumb, Level, RequestData, User } from "./event";
import { LIMITS } from "./limits";

/**
 * Mutable bag of contextual data applied to every event captured while it is active.
 * Pure data structure: no I/O, no async context. The Hub decides which scope is current.
 */
export class Scope {
  private tags: Record<string, string> = {};
  private user: User | undefined;
  private contexts: Record<string, Record<string, unknown>> = {};
  private extra: Record<string, unknown> = {};
  private breadcrumbs: Breadcrumb[] = [];
  private level: Level | undefined;
  private fingerprint: string[] | undefined;
  private request: RequestData | undefined;

  clone(): Scope {
    const s = new Scope();
    s.tags = { ...this.tags };
    s.user = this.user ? { ...this.user } : undefined;
    s.contexts = { ...this.contexts };
    s.extra = { ...this.extra };
    s.breadcrumbs = [...this.breadcrumbs];
    s.level = this.level;
    s.fingerprint = this.fingerprint ? [...this.fingerprint] : undefined;
    s.request = this.request ? { ...this.request } : undefined;
    return s;
  }

  setTag(key: string, value: string): this {
    this.tags[key] = value;
    return this;
  }

  setTags(tags: Record<string, string>): this {
    for (const [k, v] of Object.entries(tags)) this.tags[k] = v;
    return this;
  }

  /** `null` clears the user. */
  setUser(user: User | null): this {
    this.user = user ? { ...user } : undefined;
    return this;
  }

  /** `null` removes the context. */
  setContext(name: string, context: Record<string, unknown> | null): this {
    if (context === null) delete this.contexts[name];
    else this.contexts[name] = context;
    return this;
  }

  setExtra(key: string, value: unknown): this {
    this.extra[key] = value;
    return this;
  }

  setExtras(extras: Record<string, unknown>): this {
    Object.assign(this.extra, extras);
    return this;
  }

  setLevel(level: Level | undefined): this {
    this.level = level;
    return this;
  }

  setFingerprint(fingerprint: string[] | undefined): this {
    this.fingerprint = fingerprint ? [...fingerprint] : undefined;
    return this;
  }

  setRequest(request: RequestData | undefined): this {
    this.request = request ? { ...request } : undefined;
    return this;
  }

  addBreadcrumb(crumb: Breadcrumb, max: number = LIMITS.maxBreadcrumbs): this {
    const cap = Math.max(0, Math.min(max, LIMITS.maxBreadcrumbs));
    if (cap === 0) return this;
    this.breadcrumbs.push(crumb);
    if (this.breadcrumbs.length > cap) this.breadcrumbs.splice(0, this.breadcrumbs.length - cap);
    return this;
  }

  clearBreadcrumbs(): this {
    this.breadcrumbs = [];
    return this;
  }

  clear(): this {
    this.tags = {};
    this.user = undefined;
    this.contexts = {};
    this.extra = {};
    this.breadcrumbs = [];
    this.level = undefined;
    this.fingerprint = undefined;
    this.request = undefined;
    return this;
  }

  /** Read-only snapshot used by the client when building an event. */
  getData(): ScopeData {
    return {
      tags: { ...this.tags },
      user: this.user ? { ...this.user } : undefined,
      contexts: { ...this.contexts },
      extra: { ...this.extra },
      breadcrumbs: [...this.breadcrumbs],
      level: this.level,
      fingerprint: this.fingerprint ? [...this.fingerprint] : undefined,
      request: this.request ? { ...this.request } : undefined,
    };
  }
}

export interface ScopeData {
  tags: Record<string, string>;
  user: User | undefined;
  contexts: Record<string, Record<string, unknown>>;
  extra: Record<string, unknown>;
  breadcrumbs: Breadcrumb[];
  level: Level | undefined;
  fingerprint: string[] | undefined;
  request: RequestData | undefined;
}
