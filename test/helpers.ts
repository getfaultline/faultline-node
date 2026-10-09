import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { FaultlineClient } from "../src/application/client";
import { Hub } from "../src/application/hub";
import type { ILogger, ITransport } from "../src/application/ports";
import type { FaultlineEvent, FaultlineOptions, ResolvedOptions, Scope } from "../src/domain";
import { resolveOptions } from "../src/domain";
import { V8StackParser } from "../src/infrastructure/stack/v8-stack-parser";
import { FsSourceContextReader } from "../src/infrastructure/source/fs-source-context-reader";
import { nodeRuntimeInfo } from "../src/infrastructure/node/runtime";

export class FakeTransport implements ITransport {
  events: FaultlineEvent[] = [];
  send(event: FaultlineEvent): void {
    this.events.push(event);
  }
  async flush(): Promise<boolean> {
    return true;
  }
  async close(): Promise<boolean> {
    return true;
  }
}

export const silentLogger: ILogger = { debug() {}, warn() {}, error() {} };

export function resolved(overrides: FaultlineOptions = {}): ResolvedOptions {
  const r = resolveOptions({
    apiKey: "flt_ingest_test",
    endpoint: "http://127.0.0.1:1",
    ...overrides,
  });
  if (!r.ok) throw new Error(r.errors.join(", "));
  return r.options;
}

export function makeClient(
  overrides: FaultlineOptions = {},
  extra: {
    now?: () => number;
    random?: () => number;
    transport?: ITransport;
    sourceContext?: boolean;
  } = {},
) {
  const transport = extra.transport ?? new FakeTransport();
  const client = new FaultlineClient(resolved(overrides), {
    transport,
    stackParser: new V8StackParser(),
    sourceReader: extra.sourceContext ? new FsSourceContextReader() : undefined,
    clock: { now: extra.now ?? (() => Date.now()) },
    ids: { uuid: () => randomUUID() },
    random: { next: extra.random ?? (() => 0) },
    logger: silentLogger,
    runtime: nodeRuntimeInfo,
    sdkVersion: "0.0.0-test",
  });
  const hub = new Hub(new AsyncLocalStorage<Scope>());
  hub.bindClient(client);
  return { client, hub, transport: transport as FakeTransport };
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  raw: Buffer;
  body: unknown;
}

export type Responder = (
  req: RecordedRequest,
  index: number,
) => {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  delayMs?: number;
};

/** A real local HTTP server standing in for the Faultline ingest API. */
export async function startMockServer(
  responder: Responder = () => ({ status: 202, body: { accepted: 1, rejected: [] } }),
) {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      let text = raw.toString("utf8");
      if (req.headers["content-encoding"] === "gzip") text = gunzipSync(raw).toString("utf8");
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep text */
      }
      const recorded: RecordedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        raw,
        body,
      };
      requests.push(recorded);
      const r = responder(recorded, requests.length - 1);
      const send = () => {
        res.writeHead(r.status, { "content-type": "application/json", ...r.headers });
        res.end(r.body === undefined ? "" : JSON.stringify(r.body));
      };
      if (r.delayMs) setTimeout(send, r.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const tick = () => new Promise((r) => setImmediate(r));

/** Clears the process-wide scope held by the public API's singleton hub. */
export function resetGlobalScope(): void {
  const hub = (globalThis as Record<symbol, Hub | undefined>)[Symbol.for("@getfaultline/node.hub")];
  hub?.getRootScope().clear();
}
