import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ConsoleIntegration } from "../src/integrations/console";
import { ProcessIntegration, type ProcessLike } from "../src/integrations/process";
import { assertConforms } from "./contract-schema";
import { makeClient, waitFor } from "./helpers";

function fakeProcess(execArgv: string[] = [], env: Record<string, string> = {}) {
  const emitter = new EventEmitter() as EventEmitter & ProcessLike;
  emitter.execArgv = execArgv;
  emitter.env = env;
  emitter.exitCode = undefined;
  return emitter;
}

function setup(execArgv: string[] = [], env: Record<string, string> = {}) {
  const ctx = makeClient();
  const proc = fakeProcess(execArgv, env);
  const exit = vi.fn();
  const stderr: string[] = [];
  const integration = new ProcessIntegration({
    process: proc,
    exit,
    writeStderr: (t) => stderr.push(t),
    flushTimeoutMs: 500,
  });
  ctx.hub.installIntegrations([integration]);
  return { ...ctx, proc, exit, stderr, integration };
}

describe("process integration", () => {
  it("captures uncaughtException as fatal, flushes, prints and exits 1 (default behavior)", async () => {
    const { proc, exit, stderr, transport } = setup();
    const err = new Error("kaboom");
    proc.emit("uncaughtException", err, "uncaughtException");
    await waitFor(() => exit.mock.calls.length > 0);
    expect(exit).toHaveBeenCalledWith(1);
    expect(transport.events).toHaveLength(1);
    expect(transport.events[0]).toMatchObject({
      level: "fatal",
      message: "kaboom",
      tags: { mechanism: "onuncaughtexception", handled: "no" },
    });
    assertConforms(transport.events[0]);
    expect(stderr.join("")).toContain("Error: kaboom");
  });

  it("does not exit when the app registered its own uncaughtException listener", async () => {
    const { proc, exit, transport } = setup();
    proc.on("uncaughtException", () => {});
    proc.emit("uncaughtException", new Error("handled by app"));
    await new Promise((r) => setTimeout(r, 50));
    expect(exit).not.toHaveBeenCalled();
    expect(transport.events).toHaveLength(1);
  });

  it("unhandledRejection in default (throw) mode: capture, flush, exit 1", async () => {
    const { proc, exit, stderr, transport } = setup();
    proc.emit("unhandledRejection", "plain reason", Promise.resolve());
    await waitFor(() => exit.mock.calls.length > 0);
    expect(exit).toHaveBeenCalledWith(1);
    expect(transport.events[0]).toMatchObject({
      level: "fatal",
      tags: { mechanism: "onunhandledrejection" },
    });
    expect(transport.events[0]?.exception?.value).toBe("plain reason");
    expect(stderr.join("")).toContain('The promise rejected with the reason "plain reason"');
  });

  it.each([
    [["--unhandled-rejections=warn"], {}, undefined],
    [[], { NODE_OPTIONS: "--unhandled-rejections=none" }, undefined],
    [["--unhandled-rejections=warn-with-error-code"], {}, 1],
  ])("respects %j %j (no exit, exitCode=%s)", async (argv, env, exitCode) => {
    const { proc, exit, transport } = setup(argv, env);
    proc.emit("unhandledRejection", new Error("soft"));
    await new Promise((r) => setTimeout(r, 50));
    expect(exit).not.toHaveBeenCalled();
    expect(transport.events[0]?.level).toBe("error");
    expect(proc.exitCode).toBe(exitCode);
  });

  it("in strict mode the rejection is captured once (via uncaughtException)", async () => {
    const { proc, exit, transport } = setup(["--unhandled-rejections=strict"]);
    const err = new Error("strict");
    proc.emit("uncaughtException", err, "unhandledRejection");
    proc.emit("unhandledRejection", err);
    await waitFor(() => exit.mock.calls.length > 0);
    expect(transport.events).toHaveLength(1);
    expect(transport.events[0]?.tags?.mechanism).toBe("onunhandledrejection");
  });

  it("teardown removes its listeners", () => {
    const { proc, integration } = setup();
    expect(proc.listenerCount("uncaughtException")).toBe(1);
    integration.teardown();
    expect(proc.listenerCount("uncaughtException")).toBe(0);
    expect(proc.listenerCount("unhandledRejection")).toBe(0);
  });
});

describe("console integration", () => {
  it("records breadcrumbs, always calls the original, and restores on teardown", async () => {
    const { hub, client, transport } = makeClient();
    const original = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const fake = { ...original } as unknown as Console;
    const integration = new ConsoleIntegration(fake);
    hub.installIntegrations([integration]);
    fake.log("hello %s", "world");
    fake.error(new Error("printed"));
    expect(original.log).toHaveBeenCalledWith("hello %s", "world");
    expect(original.error).toHaveBeenCalledTimes(1);
    hub.captureMessage("x");
    await client.flush();
    const crumbs = transport.events[0]!.breadcrumbs!;
    expect(crumbs[0]).toMatchObject({
      type: "log",
      category: "console",
      level: "info",
      message: "hello world",
    });
    expect(crumbs[1]).toMatchObject({ level: "error" });
    expect(crumbs[1]?.message).toContain("Error: printed");
    integration.teardown();
    expect(fake.log).toBe(original.log);
  });
});
