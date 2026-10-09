#!/usr/bin/env node
// Smoke test of the BUILT package (dist/). Runs on any Node >= 18 without dev dependencies:
//  1. `require` (CJS) and `import` (ESM) both load and expose the public API
//  2. events reach a local mock ingest server (gzip, contract fields)
//  3. an uncaught exception is captured, flushed, and the process still exits with code 1
//  4. the SDK never keeps the process alive (unref'd timers)
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const API = [
  "init",
  "captureException",
  "captureMessage",
  "setUser",
  "setTag",
  "setTags",
  "setContext",
  "addBreadcrumb",
  "withScope",
  "flush",
  "close",
  "Handlers",
];
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures++;
};

// 1. module formats
const cjs = require(join(root, "dist/index.cjs"));
const esm = await import(join(root, "dist/index.js"));
check(
  API.every((k) => k in cjs),
  "CJS require exposes the public API",
);
check(
  API.every((k) => k in esm),
  "ESM import exposes the public API",
);
check(
  cjs.SDK_VERSION === esm.SDK_VERSION && /^\d+\.\d+\.\d+/.test(cjs.SDK_VERSION),
  `SDK_VERSION ${cjs.SDK_VERSION}`,
);

// mock ingest server
const received = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let raw = Buffer.concat(chunks);
    if (req.headers["content-encoding"] === "gzip") raw = gunzipSync(raw);
    received.push(JSON.parse(raw.toString("utf8")));
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ accepted: 1, rejected: [] }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${server.address().port}`;

// 2. end-to-end through both builds
for (const [label, mod] of [
  ["CJS", cjs],
  ["ESM", esm],
]) {
  received.length = 0;
  mod.init({ apiKey: "flt_ingest_smoke", endpoint, integrations: { process: false } });
  mod.captureException(new Error(`smoke ${label}`, { cause: new Error("root") }));
  await mod.flush(3000);
  const event = received[0]?.events?.[0];
  check(
    event?.sdk?.name === "@getfaultline/node" &&
      event?.platform === "node" &&
      event?.exception?.cause?.value === "root",
    `${label}: event delivered and shaped per contract`,
  );
  await mod.close(1000);
}

// 3. uncaught exception in a child process → captured, flushed, exit code 1
received.length = 0;
const result = await new Promise((resolve) => {
  const p = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `
    import * as F from ${JSON.stringify(join(root, "dist/index.js"))};
    F.init({ apiKey: "k", endpoint: ${JSON.stringify(endpoint)} });
    setTimeout(() => { throw new Error("fatal smoke"); }, 10);
  `,
  ]);
  let stderr = "";
  p.stderr.on("data", (d) => (stderr += d));
  p.on("exit", (code) => resolve({ code, stderr }));
});
const fatal = received.flatMap((b) => b.events).find((e) => e.message === "fatal smoke");
check(fatal?.level === "fatal", "uncaughtException captured as fatal and flushed before exit");
check(result.code === 1, `process still exits with code 1 (got ${result.code})`);
check(result.stderr.includes("Error: fatal smoke"), "default stack trace still printed to stderr");

server.close();

// 4. never keeps the process alive: unreachable endpoint, no flush → exits promptly
const started = Date.now();
execFileSync(
  process.execPath,
  [
    "-e",
    `
  const F = require(${JSON.stringify(join(root, "dist/index.cjs"))});
  F.init({ apiKey: "k", endpoint: "http://127.0.0.1:9" });
  F.captureMessage("left in queue");
`,
  ],
  { timeout: 10_000 },
);
check(
  Date.now() - started < 3000,
  `process with queued events exits promptly (${Date.now() - started}ms)`,
);

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) failed`);
  process.exit(1);
}
console.log("\nall smoke checks passed");
