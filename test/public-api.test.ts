import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Faultline from "../src/index";
import { assertConforms, batchSchema } from "./contract-schema";
import { resetGlobalScope, startMockServer } from "./helpers";
import type { FaultlineEvent } from "../src/domain";

type Server = Awaited<ReturnType<typeof startMockServer>>;
let server: Server;

beforeEach(async () => {
  server = await startMockServer((req) =>
    req.url === "/api/v1/ingest/events"
      ? { status: 202, body: { accepted: 1, rejected: [] } }
      : { status: 200, body: { ok: true } },
  );
});

afterEach(async () => {
  await Faultline.close(500);
  resetGlobalScope();
  await server.close();
});

const ingested = (): FaultlineEvent[] =>
  server.requests
    .filter((r) => r.url === "/api/v1/ingest/events")
    .flatMap((r) => batchSchema.parse(r.body).events as unknown as FaultlineEvent[]);

describe("public API end-to-end against a local ingest server", () => {
  it("sends conformant events through init → capture → flush", async () => {
    Faultline.init({
      apiKey: "flt_ingest_e2e",
      endpoint: server.url,
      environment: "test",
      release: "e2e@1.0.0",
      integrations: { process: false, console: false, http: false },
    });
    Faultline.setTag("region", "eu");
    Faultline.setUser({ id: "42", email: "dev@example.com" });
    Faultline.setContext("order", { id: "o-1" });
    Faultline.addBreadcrumb({ type: "navigation", message: "to /checkout" });
    const id = Faultline.captureException(new TypeError("bad", { cause: new Error("root") }), {
      tags: { feature: "pay" },
      level: "fatal",
      fingerprint: ["pay-failure"],
    });
    Faultline.captureMessage("Payment webhook retried", "warning");
    Faultline.withScope((scope) => {
      scope.setTag("scoped", "yes");
      Faultline.captureException("a string was thrown");
    });
    expect(await Faultline.flush(2000)).toBe(true);

    const events = ingested();
    expect(events).toHaveLength(3);
    events.forEach(assertConforms);
    // processing is async (source context), so arrival order is not guaranteed
    const ex = events.find((e) => e.eventId === id);
    const msg = events.find((e) => e.message === "Payment webhook retried");
    const str = events.find((e) => e.exception?.value === "a string was thrown");
    expect(ex).toMatchObject({
      eventId: id,
      level: "fatal",
      environment: "test",
      release: "e2e@1.0.0",
      fingerprint: ["pay-failure"],
      tags: { region: "eu", feature: "pay" },
      user: { id: "42", email: "dev@example.com" },
      sdk: { name: "@faultline/node" },
    });
    expect(ex?.exception?.cause?.value).toBe("root");
    expect(ex?.exception?.stacktrace.frames.at(-1)?.contextLine).toContain("new TypeError");
    expect(msg).toMatchObject({ message: "Payment webhook retried", level: "warning" });
    expect(str?.tags).toMatchObject({ scoped: "yes" });
    expect(str?.exception?.value).toBe("a string was thrown");
    // synthetic stack starts at the caller, not inside the SDK
    expect(str?.exception?.stacktrace.frames.at(-1)?.filename).toContain("public-api.test.ts");
    expect(server.requests[0]?.headers["x-faultline-key"]).toBe("flt_ingest_e2e");
  });

  it("records http/fetch/console breadcrumbs but never the SDK's own ingest requests", async () => {
    Faultline.init({
      apiKey: "k",
      endpoint: server.url,
      integrations: { process: false, console: true, http: true },
    });
    Faultline.captureMessage("first");
    await Faultline.flush(2000);

    await fetch(`${server.url}/other?token=abc`);
    await new Promise<void>((resolve, reject) => {
      http
        .get(`${server.url}/legacy`, (res) => {
          res.resume();
          res.on("end", resolve);
        })
        .on("error", reject);
    });
    await new Promise((r) => setTimeout(r, 20));
    console.warn("something odd", { n: 1 });
    Faultline.captureMessage("second");
    await Faultline.flush(2000);

    const second = ingested().find((e) => e.message === "second")!;
    const crumbs = second.breadcrumbs ?? [];
    const urls = crumbs.map((c) => (typeof c.data?.url === "string" ? c.data.url : ""));
    expect(urls.some((u) => u.endsWith("/other?token=[Filtered]"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/legacy"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/v1/ingest"))).toBe(false);
    expect(crumbs.find((c) => c.category === "fetch")).toMatchObject({
      type: "http",
      level: "info",
      data: { method: "GET", status_code: 200 },
    });
    expect(crumbs.find((c) => c.category === "http")).toMatchObject({
      type: "http",
      data: { method: "GET", status_code: 200 },
    });
    expect(crumbs.find((c) => c.category === "console")).toMatchObject({
      type: "log",
      level: "warning",
      message: "something odd { n: 1 }",
    });
  });

  it("close() removes instrumentation and stops sending", async () => {
    const originalFetch = globalThis.fetch;
    const originalGet = http.get;
    Faultline.init({
      apiKey: "k",
      endpoint: server.url,
      integrations: { process: false, console: true, http: true },
    });
    expect(globalThis.fetch).not.toBe(originalFetch);
    await Faultline.close(1000);
    expect(globalThis.fetch).toBe(originalFetch);
    expect(http.get).toBe(originalGet);
    expect(Faultline.captureMessage("after close")).toBeUndefined();
  });
});
