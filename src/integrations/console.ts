import { format } from "node:util";
import type { Hub, Integration } from "../application/hub";
import type { Level } from "../domain";
import { truncate } from "../domain";

const METHODS = {
  debug: "debug",
  info: "info",
  log: "info",
  warn: "warning",
  error: "error",
} as const satisfies Record<string, Level>;

type Method = keyof typeof METHODS;
type ConsoleFn = (...args: unknown[]) => void;

/** Turns console.* calls into "log" breadcrumbs. The original method is always called. */
export class ConsoleIntegration implements Integration {
  readonly name = "console";
  private readonly originals = new Map<Method, { original: ConsoleFn; wrapped: ConsoleFn }>();

  constructor(private readonly target: Console = console) {}

  setup(hub: Hub): void {
    let recording = false;
    const target = this.target as unknown as Record<Method, ConsoleFn>;
    for (const method of Object.keys(METHODS) as Method[]) {
      const original = target[method];
      if (typeof original !== "function") continue;
      const level = METHODS[method];
      const wrapped = function (this: unknown, ...args: unknown[]): void {
        if (!recording) {
          recording = true;
          try {
            hub.addBreadcrumb({
              type: "log",
              category: "console",
              level,
              message: truncate(format(...args), 1000),
            });
          } catch {
            /* never break console */
          } finally {
            recording = false;
          }
        }
        original.apply(this, args);
      };
      target[method] = wrapped;
      this.originals.set(method, { original, wrapped });
    }
  }

  teardown(): void {
    const target = this.target as unknown as Record<Method, ConsoleFn>;
    for (const [method, { original, wrapped }] of this.originals) {
      if (target[method] === wrapped) target[method] = original;
    }
    this.originals.clear();
  }
}
