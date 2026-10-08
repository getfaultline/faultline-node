import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { FaultlineEvent } from "../src/domain";
import { HttpTransport } from "../src/infrastructure/transport/http-transport";
import { batchSchema } from "./contract-schema";
import { silentLogger, startMockServer } from "./helpers";

type Server = Awaited<ReturnType<typeof startMockServer>>;
let server: Server | undefined;
let transport: HttpTransport | undefined;

afterEach(async () => {
  await transport?.close(0);
  await server?.close();
  server = undefined;
  transport = undefined;
});

function event(message = "hello"): FaultlineEvent {
  return {
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    level: "error",
    platform: "node",
    message,
    sdk: { name: "@faultline/node", version: "0.0.0-test" },
  };
}

function make(
  url: string,
  overrides: Partial<ConstructorParameters<typeof HttpTransport>[0]> = {},
) {
  transport = new HttpTransport({
    endpoint: url,
    apiKey: "flt_ingest_abc",
    logger: silentLogger,
    backoffBaseMs: 20,
    backoffMaxMs: 100,
    random: () => 0.5,
    ...overrides,
  });
  return transport;
}

const eventsIn = (body: unknown) => (body as { events: FaultlineEvent[] }).events;

describe("HttpTransport", () => {
  it("POSTs gzip-compressed batches with the ingest key to /api/v1/ingest/events", async () => {
    server = await startMockServer();
    const t = make(server.url + "/");
    t.send(event("a"));
    t.send(event("b"));
    expect(await t.flush(2000)).toBe(true);
    expect(server.requests).toHaveLength(1);
    const req = server.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/api/v1/ingest/events");
    expect(req.headers["x-faultline-key"]).toBe("flt_ingest_abc");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["content-encoding"]).toBe("gzip");
    expect(req.raw[0]).toBe(0x1f); // gzip magic bytes
    expect(req.raw[1]).toBe(0x8b);
    expect(eventsIn(req.body).map((e) => e.message)).toEqual(["a", "b"]);
    batchSchema.parse(req.body);
  });

  it("flushes automatically once 20 events are queued", async () => {
    server = await startMockServer();
    const t = make(server.url, { flushIntervalMs: 60_000 });
    for (let i = 0; i < 20; i++) t.send(event(String(i)));
    await new Promise((r) => setTimeout(r, 300));
    expect(server.requests).toHaveLength(1);
    expect(eventsIn(server.requests[0]!.body)).toHaveLength(20);
  });

  it("flushes on the interval timer", async () => {
    server = await startMockServer();
    const t = make(server.url, { flushIntervalMs: 50 });
    t.send(event());
    await new Promise((r) => setTimeout(r, 300));
    expect(server.requests).toHaveLength(1);
  });

  it("splits into batches of at most 50 and drops the oldest beyond 100 queued", async () => {
    server = await startMockServer();
    const t = make(server.url, { flushAt: 1000, flushIntervalMs: 60_000 });
    for (let i = 0; i < 130; i++) t.send(event(String(i)));
    expect(t.queueLength).toBe(100);
    await t.flush(3000);
    const sizes = server.requests.map((r) => eventsIn(r.body).length);
    expect(sizes).toEqual([50, 50]);
    expect(eventsIn(server.requests[0]!.body)[0]?.message).toBe("30"); // 0..29 dropped
  });

  it("retries 5xx with exponential backoff + jitter, then succeeds", async () => {
    const times: number[] = [];
    server = await startMockServer((_req, i) => {
      times.push(Date.now());
      return i < 2 ? { status: 503 } : { status: 202, body: { accepted: 1, rejected: [] } };
    });
    const t = make(server.url);
    t.send(event());
    expect(await t.flush(3000)).toBe(true);
    expect(server.requests).toHaveLength(3);
    // base 20ms, equal jitter with random 0.5 → 15ms, then 30ms
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(10);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(25);
    expect(t.queueLength).toBe(0);
  });

  it("computes backoff within the jittered exponential envelope", () => {
    const t = make("http://127.0.0.1:1", {
      backoffBaseMs: 1000,
      backoffMaxMs: 30_000,
      random: () => 0,
    });
    expect(t.backoff(0)).toBe(500);
    expect(t.backoff(3)).toBe(4000);
    const t2 = make("http://127.0.0.1:1", {
      backoffBaseMs: 1000,
      backoffMaxMs: 30_000,
      random: () => 0.999999,
    });
    expect(t2.backoff(3)).toBeLessThanOrEqual(8000);
    expect(t2.backoff(10)).toBeLessThanOrEqual(30_000);
  });

  it("gives up after maxRetries on persistent failure", async () => {
    server = await startMockServer(() => ({ status: 500 }));
    const t = make(server.url, { maxRetries: 2 });
    t.send(event());
    expect(await t.flush(3000)).toBe(true);
    expect(server.requests).toHaveLength(3);
  });

  it("retries network errors (connection refused) without throwing", async () => {
    const t = make("http://127.0.0.1:1", { maxRetries: 1 });
    t.send(event());
    await expect(t.flush(2000)).resolves.toBe(true);
  });

  it("honors 429 Retry-After before retrying", async () => {
    const times: number[] = [];
    server = await startMockServer((_req, i) => {
      times.push(Date.now());
      return i === 0
        ? { status: 429, headers: { "retry-after": "1" } }
        : { status: 202, body: { accepted: 1, rejected: [] } };
    });
    const t = make(server.url);
    t.send(event("limited"));
    expect(await t.flush(5000)).toBe(true);
    expect(server.requests).toHaveLength(2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(950);
    expect(eventsIn(server.requests[1]!.body)[0]?.message).toBe("limited");
  });

  it("flush returns false when Retry-After exceeds the flush timeout", async () => {
    server = await startMockServer(() => ({ status: 429, headers: { "retry-after": "60" } }));
    const t = make(server.url);
    t.send(event());
    expect(await t.flush(500)).toBe(false);
    expect(server.requests).toHaveLength(1);
  });

  it.each([401, 413, 400])("drops the batch on %i without retrying", async (status) => {
    server = await startMockServer(() => ({ status }));
    const t = make(server.url);
    t.send(event());
    expect(await t.flush(2000)).toBe(true);
    expect(server.requests).toHaveLength(1);
    expect(t.queueLength).toBe(0);
  });

  it("times out slow requests via AbortController and retries", async () => {
    server = await startMockServer((_req, i) =>
      i === 0
        ? { status: 202, delayMs: 1000 }
        : { status: 202, body: { accepted: 1, rejected: [] } },
    );
    const t = make(server.url, { timeoutMs: 100 });
    t.send(event());
    expect(await t.flush(3000)).toBe(true);
    expect(server.requests.length).toBeGreaterThanOrEqual(2);
  });

  it("can send uncompressed JSON when compression is disabled", async () => {
    server = await startMockServer();
    const t = make(server.url, { compress: false });
    t.send(event("plain"));
    await t.flush(2000);
    expect(server.requests[0]!.headers["content-encoding"]).toBeUndefined();
    expect(eventsIn(server.requests[0]!.body)[0]?.message).toBe("plain");
  });

  it("ignores sends after close and never keeps the event loop alive", async () => {
    server = await startMockServer();
    const t = make(server.url);
    t.send(event());
    await t.close(2000);
    t.send(event());
    expect(t.queueLength).toBe(0);
    expect(server.requests).toHaveLength(1);
  });
});
