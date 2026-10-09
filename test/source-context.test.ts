import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FsSourceContextReader } from "../src/infrastructure/source/fs-source-context-reader";
import { resolveOptions } from "../src/domain";

const dir = mkdtempSync(join(tmpdir(), "faultline-src-"));
const file = join(dir, "app.js");
writeFileSync(
  file,
  Array.from({ length: 20 }, (_, i) => `line ${i + 1}${i === 9 ? "x".repeat(400) : ""}`).join("\n"),
);

describe("FsSourceContextReader", () => {
  it("adds ±5 lines around in-app frames, clipping long lines to 300 chars", async () => {
    const reader = new FsSourceContextReader();
    const [frame] = await reader.addSourceContext([{ filename: file, lineno: 10, inApp: true }]);
    expect(frame?.preContext).toEqual(["line 5", "line 6", "line 7", "line 8", "line 9"]);
    expect(frame?.contextLine).toHaveLength(300);
    expect(frame?.contextLine?.startsWith("line 10x")).toBe(true);
    expect(frame?.postContext).toEqual(["line 11", "line 12", "line 13", "line 14", "line 15"]);
  });

  it("handles file edges, non-in-app frames and missing files", async () => {
    const reader = new FsSourceContextReader();
    const frames = await reader.addSourceContext([
      { filename: file, lineno: 1, inApp: true },
      { filename: file, lineno: 20, inApp: true },
      { filename: file, lineno: 999, inApp: true },
      { filename: file, lineno: 3, inApp: false },
      { filename: join(dir, "missing.js"), lineno: 1, inApp: true },
    ]);
    expect(frames[0]?.preContext).toEqual([]);
    expect(frames[1]?.postContext).toEqual([]);
    expect(frames[2]?.contextLine).toBeUndefined();
    expect(frames[3]?.contextLine).toBeUndefined();
    expect(frames[4]?.contextLine).toBeUndefined();
  });

  it("skips files over the size cap", async () => {
    const big = join(dir, "big.js");
    writeFileSync(big, "a\n".repeat(600_000)); // ~1.2 MB
    const reader = new FsSourceContextReader();
    const [frame] = await reader.addSourceContext([{ filename: big, lineno: 2, inApp: true }]);
    expect(frame?.contextLine).toBeUndefined();
  });

  it("is an LRU bounded by entry count", async () => {
    const reader = new FsSourceContextReader({ maxCacheEntries: 2 });
    const files = ["a", "b", "c"].map((n) => {
      const p = join(dir, `${n}.js`);
      writeFileSync(p, `${n}\n`);
      return p;
    });
    await reader.addSourceContext([{ filename: files[0]!, lineno: 1, inApp: true }]);
    await reader.addSourceContext([{ filename: files[1]!, lineno: 1, inApp: true }]);
    await reader.addSourceContext([{ filename: files[0]!, lineno: 1, inApp: true }]); // touch a
    await reader.addSourceContext([{ filename: files[2]!, lineno: 1, inApp: true }]);
    expect(reader.cachedFiles).toEqual([files[0], files[2]]);
  });
});

describe("resolveOptions", () => {
  it("applies documented defaults", () => {
    const r = resolveOptions({ apiKey: "flt_ingest_x" });
    expect(r.ok && r.options).toMatchObject({
      endpoint: "https://www.faultsline.dev",
      sampleRate: 1,
      maxBreadcrumbs: 50,
      sendDefaultPii: false,
      ignoreErrors: [],
      integrations: { process: true, express: false, console: true, http: true },
      enabled: true,
      debug: false,
    });
  });

  it("strips trailing slashes from the endpoint and caps maxBreadcrumbs at 100", () => {
    const r = resolveOptions({
      apiKey: "k",
      endpoint: "http://localhost:4000/",
      maxBreadcrumbs: 500,
    });
    expect(r.ok && r.options.endpoint).toBe("http://localhost:4000");
    expect(r.ok && r.options.maxBreadcrumbs).toBe(100);
  });

  it("requires apiKey only when enabled", () => {
    expect(resolveOptions({}).ok).toBe(false);
    expect(resolveOptions({ enabled: false }).ok).toBe(true);
  });
});
