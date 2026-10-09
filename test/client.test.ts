import { describe, expect, it } from "vitest";
import { assertConforms } from "./contract-schema";
import { makeClient } from "./helpers";

describe("FaultlineClient: event building", () => {
  it("builds a contract-conformant exception event with scope data", async () => {
    const { hub, client, transport } = makeClient({
      environment: "test",
      release: "api@1.0.0",
      serverName: "web-1",
    });
    hub.setTag("region", "eu");
    hub.setUser({ id: "u1", email: "a@b.c" });
    hub.setContext("order", { id: 42 });
    hub.addBreadcrumb({ message: "clicked", category: "ui" });
    const id = hub.captureException(new TypeError("bad thing"), {
      tags: { feature: "checkout" },
      extra: { cart: 3 },
    });
    await client.flush();
    expect(transport.events).toHaveLength(1);
    const e = transport.events[0]!;
    assertConforms(e);
    expect(e.eventId).toBe(id);
    expect(e).toMatchObject({
      level: "error",
      platform: "node",
      environment: "test",
      release: "api@1.0.0",
      serverName: "web-1",
      message: "bad thing",
      tags: { region: "eu", feature: "checkout" },
      user: { id: "u1", email: "a@b.c" },
      extra: { cart: 3 },
      sdk: { name: "@getfaultline/node", version: "0.0.0-test" },
    });
    expect(e.exception?.type).toBe("TypeError");
    expect(e.exception?.stacktrace.frames.at(-1)?.filename).toContain("client.test.ts");
    expect(e.contexts?.runtime).toEqual({ name: "node", version: process.version });
    expect(e.contexts?.order).toEqual({ id: 42 });
    expect(e.breadcrumbs?.[0]).toMatchObject({
      type: "default",
      message: "clicked",
      category: "ui",
    });
  });

  it("captureMessage uses the given level (default info)", async () => {
    const { hub, client, transport } = makeClient();
    hub.captureMessage("hello");
    hub.captureMessage("careful", "warning");
    await client.flush();
    expect(transport.events.map((e) => [e.message, e.level])).toEqual([
      ["hello", "info"],
      ["careful", "warning"],
    ]);
    transport.events.forEach(assertConforms);
  });

  it("adds source context to in-app frames", async () => {
    const { hub, client, transport } = makeClient({}, { sourceContext: true });
    hub.captureException(new Error("with context"));
    await client.flush();
    const frame = transport.events[0]!.exception!.stacktrace.frames.at(-1)!;
    expect(frame.contextLine).toContain('new Error("with context")');
    expect(frame.preContext!.length).toBeLessThanOrEqual(5);
    expect(frame.postContext!.length).toBeLessThanOrEqual(5);
    assertConforms(transport.events[0]);
  });
});

describe("FaultlineClient: Error.cause chain", () => {
  it("follows cause chains", async () => {
    const { hub, client, transport } = makeClient();
    const root = new Error("db down");
    const mid = new Error("query failed", { cause: root });
    hub.captureException(new Error("request failed", { cause: mid }));
    await client.flush();
    const ex = transport.events[0]!.exception!;
    expect(ex.value).toBe("request failed");
    expect(ex.cause?.value).toBe("query failed");
    expect(ex.cause?.cause?.value).toBe("db down");
    expect(ex.cause?.cause?.cause).toBeUndefined();
  });

  it("caps the chain at depth 5 and survives cycles", async () => {
    const { hub, client, transport } = makeClient();
    let err = new Error("e0");
    for (let i = 1; i < 10; i++) err = new Error(`e${i}`, { cause: err });
    hub.captureException(err);
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b", { cause: a });
    a.cause = b;
    hub.captureException(a);
    await client.flush();
    let depth = 0;
    for (let ex = transport.events[0]!.exception; ex; ex = ex.cause) depth++;
    expect(depth).toBe(5);
    const cyclic = transport.events[1]!.exception!;
    expect(cyclic.cause?.value).toBe("b");
    expect(cyclic.cause?.cause).toBeUndefined();
    transport.events.forEach(assertConforms);
  });

  it("wraps non-Error causes", async () => {
    const { hub, client, transport } = makeClient();
    hub.captureException(new Error("outer", { cause: "just a string" }));
    await client.flush();
    expect(transport.events[0]!.exception!.cause).toMatchObject({
      type: "NonErrorCause",
      value: "just a string",
    });
  });
});

describe("FaultlineClient: non-Error throwables", () => {
  it.each([
    ["a string", "a string"],
    [42, "Non-Error thrown: 42"],
    [null, "Non-Error thrown: null"],
    [undefined, "Non-Error thrown: undefined"],
    [{ code: "E1", detail: { x: 1 } }, "Non-Error object thrown with keys: code, detail"],
  ])("converts %p into a synthetic exception", async (thrown, expected) => {
    const { hub, client, transport } = makeClient();
    hub.captureException(thrown, { syntheticStack: new Error().stack });
    await client.flush();
    const e = transport.events[0]!;
    assertConforms(e);
    expect(e.exception?.type).toBe("Error");
    expect(e.exception?.value.startsWith(expected)).toBe(true);
    expect(e.exception?.stacktrace.frames.length).toBeGreaterThan(0);
  });

  it("handles circular objects, symbols and BigInt", async () => {
    const { hub, client, transport } = makeClient();
    const circ: Record<string, unknown> = { n: 10n };
    circ.self = circ;
    hub.captureException(circ);
    hub.captureException(Symbol("s"));
    hub.captureException(new Error("with extra"), { extra: { circ, fn: () => 1, big: 1n } });
    await client.flush();
    expect(transport.events).toHaveLength(3);
    transport.events.forEach(assertConforms);
    expect(transport.events[2]!.extra).toMatchObject({
      circ: { n: "10n", self: "[Circular]" },
      big: "1n",
    });
  });
});

describe("FaultlineClient: sampling, ignoreErrors, beforeSend, dedupe", () => {
  it("applies sampleRate", async () => {
    const dropped = makeClient({ sampleRate: 0.25 }, { random: () => 0.5 });
    expect(dropped.hub.captureMessage("x")).toBeUndefined();
    const kept = makeClient({ sampleRate: 0.25 }, { random: () => 0.1 });
    expect(kept.hub.captureMessage("x")).toBeDefined();
    const none = makeClient({ sampleRate: 0 }, { random: () => 0 });
    expect(none.hub.captureMessage("x")).toBeUndefined();
  });

  it("ignores errors by substring and RegExp on type and message", async () => {
    const { hub, client, transport } = makeClient({ ignoreErrors: [/ECONNRESET/, "AbortError"] });
    const abort = new Error("aborted");
    abort.name = "AbortError";
    hub.captureException(abort);
    hub.captureException(new Error("read ECONNRESET"));
    hub.captureException(new Error("real problem"));
    await client.flush();
    expect(transport.events.map((e) => e.message)).toEqual(["real problem"]);
  });

  it("beforeSend can modify, drop (null) or be async", async () => {
    const { hub, client, transport } = makeClient({
      beforeSend: async (event) => {
        if (event.message === "drop me") return null;
        return { ...event, tags: { ...event.tags, touched: "yes" } };
      },
    });
    hub.captureMessage("keep me");
    hub.captureMessage("drop me");
    await client.flush();
    expect(transport.events).toHaveLength(1);
    expect(transport.events[0]!.tags).toEqual({ touched: "yes" });
  });

  it("re-sanitizes whatever beforeSend returns", async () => {
    const { hub, client, transport } = makeClient({
      beforeSend: (event) => ({
        ...event,
        level: "nope" as never,
        tags: { [`k${"x".repeat(50)}`]: "v".repeat(500) },
        platform: "browser" as never,
      }),
    });
    hub.captureMessage("x");
    await client.flush();
    assertConforms(transport.events[0]);
    expect(transport.events[0]!.level).toBe("error");
  });

  it("dedupes identical consecutive errors within 1s", async () => {
    let now = 1_000_000;
    const { hub, client, transport } = makeClient({}, { now: () => now });
    // created on the same line/column → identical type, message and frames
    const errs = [0, 1, 2].map(() => new Error("same"));
    hub.captureException(errs[0]);
    now += 500;
    expect(hub.captureException(errs[1])).toBeUndefined();
    now += 600;
    expect(hub.captureException(errs[2])).toBeDefined(); // > 1s since the last sent duplicate
    hub.captureException(new Error("different"));
    await client.flush();
    expect(transport.events.map((e) => e.message)).toEqual(["same", "same", "different"]);
  });

  it("dedupe is consecutive-only and respects custom fingerprints", async () => {
    const { hub, client, transport } = makeClient();
    hub.captureMessage("a");
    hub.captureMessage("b");
    hub.captureMessage("a");
    hub.captureMessage("x", undefined, { fingerprint: ["grp"] });
    hub.captureMessage("y", undefined, { fingerprint: ["grp"] });
    await client.flush();
    expect(transport.events.map((e) => e.message)).toEqual(["a", "b", "a", "x"]);
  });
});

describe("FaultlineClient: limits", () => {
  it("enforces message, tag and breadcrumb limits", async () => {
    const { hub, client, transport } = makeClient({ maxBreadcrumbs: 100 });
    const tags: Record<string, string> = {};
    for (let i = 0; i < 80; i++) tags[`tag${i}`] = "v";
    for (let i = 0; i < 150; i++) hub.addBreadcrumb({ message: `c${i}` });
    hub.captureMessage("m".repeat(20_000), "info", { tags });
    await client.flush();
    const e = transport.events[0]!;
    assertConforms(e);
    expect(e.message).toHaveLength(8192);
    expect(e.message!.endsWith("…")).toBe(true);
    expect(Object.keys(e.tags!)).toHaveLength(50);
    expect(e.breadcrumbs).toHaveLength(100);
    expect(e.breadcrumbs!.at(-1)?.message).toBe("c149");
  });

  it("respects maxBreadcrumbs", async () => {
    const { hub, client, transport } = makeClient({ maxBreadcrumbs: 3 });
    for (let i = 0; i < 10; i++) hub.addBreadcrumb({ message: `c${i}` });
    hub.captureMessage("x");
    await client.flush();
    expect(transport.events[0]!.breadcrumbs!.map((b) => b.message)).toEqual(["c7", "c8", "c9"]);
  });
});
