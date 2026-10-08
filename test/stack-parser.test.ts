import { describe, expect, it } from "vitest";
import { V8StackParser } from "../src/infrastructure/stack/v8-stack-parser";
import { stackFrameSchema } from "./contract-schema";

const parser = new V8StackParser();

describe("V8StackParser", () => {
  it("parses a sync stack and orders frames oldest → newest", () => {
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'id')",
      "    at getUser (/srv/app/src/users.js:42:17)",
      "    at handler (/srv/app/src/routes.js:10:5)",
      "    at Layer.handle [as handle_request] (/srv/app/node_modules/express/lib/router/layer.js:95:5)",
      "    at Module._compile (node:internal/modules/cjs/loader:1105:14)",
    ].join("\n");
    const frames = parser.parse(stack);
    expect(frames).toHaveLength(4);
    expect(frames[3]).toEqual({
      filename: "/srv/app/src/users.js",
      function: "getUser",
      lineno: 42,
      colno: 17,
      inApp: true,
    });
    expect(frames[2]).toMatchObject({ function: "handler", inApp: true });
    expect(frames[1]).toMatchObject({
      filename: "/srv/app/node_modules/express/lib/router/layer.js",
      function: "Layer.handle [as handle_request]",
      module: "express/lib/router/layer",
      inApp: false,
    });
    expect(frames[0]).toMatchObject({
      filename: "node:internal/modules/cjs/loader",
      lineno: 1105,
      inApp: false,
    });
    for (const f of frames) stackFrameSchema.parse(f);
  });

  it("parses async frames", () => {
    const stack = [
      "Error: boom",
      "    at fetchOrder (/srv/app/orders.js:12:11)",
      "    at async processOrder (/srv/app/orders.js:30:3)",
      "    at async Promise.all (index 0)",
      "    at async main (/srv/app/index.js:5:3)",
    ].join("\n");
    const frames = parser.parse(stack);
    expect(frames.map((f) => f.function)).toEqual([
      "main",
      "Promise.all",
      "processOrder",
      "fetchOrder",
    ]);
    expect(frames[1]).toMatchObject({ filename: "native", inApp: false });
    expect(frames[2]).toMatchObject({
      filename: "/srv/app/orders.js",
      lineno: 30,
      colno: 3,
      inApp: true,
    });
  });

  it("parses anonymous frames (with and without a function name)", () => {
    const stack = [
      "Error: x",
      "    at /srv/app/anon.js:3:9",
      "    at Object.<anonymous> (/srv/app/anon.js:7:1)",
      "    at <anonymous> (/srv/app/anon.js:9:2)",
      "    at new Widget (/srv/app/widget.js:4:11)",
    ].join("\n");
    const frames = parser.parse(stack).reverse();
    expect(frames[0]).toEqual({ filename: "/srv/app/anon.js", lineno: 3, colno: 9, inApp: true });
    expect(frames[1]).toMatchObject({ function: "Object.<anonymous>", lineno: 7 });
    expect(frames[2]?.function).toBeUndefined();
    expect(frames[3]).toMatchObject({ function: "new Widget", filename: "/srv/app/widget.js" });
  });

  it("parses native frames", () => {
    const stack = [
      "Error: x",
      "    at Array.map (<anonymous>)",
      "    at JSON.parse (native)",
      "    at run (/srv/a.js:1:1)",
    ].join("\n");
    const frames = parser.parse(stack).reverse();
    expect(frames[0]).toEqual({ filename: "<anonymous>", function: "Array.map", inApp: false });
    expect(frames[1]).toEqual({ filename: "native", function: "JSON.parse", inApp: false });
    expect(frames[2]?.inApp).toBe(true);
  });

  it("parses eval frames using the eval origin location", () => {
    const stack = [
      "Error: in eval",
      "    at eval (eval at runScript (/srv/app/script.js:8:3), <anonymous>:1:7)",
      "    at runScript (/srv/app/script.js:8:3)",
    ].join("\n");
    const frames = parser.parse(stack).reverse();
    expect(frames[0]).toMatchObject({
      function: "eval",
      filename: "/srv/app/script.js",
      lineno: 8,
      colno: 3,
      inApp: true,
    });
  });

  it("parses Windows paths", () => {
    const stack = [
      "Error: win",
      "    at handler (C:\\Users\\dev\\app\\src\\index.js:12:7)",
      "    at C:\\Users\\dev\\app\\src\\anon.js:3:1",
      "    at Router.handle (C:\\Users\\dev\\app\\node_modules\\express\\lib\\router\\index.js:284:7)",
    ].join("\n");
    const frames = parser.parse(stack).reverse();
    expect(frames[0]).toEqual({
      filename: "C:\\Users\\dev\\app\\src\\index.js",
      function: "handler",
      lineno: 12,
      colno: 7,
      inApp: true,
    });
    expect(frames[1]).toEqual({
      filename: "C:\\Users\\dev\\app\\src\\anon.js",
      lineno: 3,
      colno: 1,
      inApp: true,
    });
    expect(frames[2]).toMatchObject({ inApp: false, module: "express/lib/router/index" });
  });

  it("converts file:// URLs (ESM) to paths, including Windows drive letters", () => {
    const stack = [
      "Error: esm",
      "    at main (file:///srv/app/my%20dir/index.mjs:4:9)",
      "    at file:///C:/dev/app/main.mjs:1:1",
    ].join("\n");
    const frames = parser.parse(stack).reverse();
    expect(frames[0]).toMatchObject({
      filename: "/srv/app/my dir/index.mjs",
      lineno: 4,
      inApp: true,
    });
    expect(frames[1]).toMatchObject({ filename: "C:/dev/app/main.mjs", inApp: true });
  });

  it("keeps the newest 100 frames and tolerates garbage", () => {
    const lines = ["Error: deep"];
    for (let i = 0; i < 150; i++) lines.push(`    at fn${i} (/srv/app/deep.js:${i + 1}:1)`);
    const frames = parser.parse(lines.join("\n"));
    expect(frames).toHaveLength(100);
    expect(frames[99]?.function).toBe("fn0"); // newest last
    expect(parser.parse(undefined)).toEqual([]);
    expect(parser.parse("not a stack")).toEqual([]);
    expect(parser.parse("Error\n    at ")).toEqual([]);
  });

  it("parses a real V8 stack from this process", () => {
    function inner(): Error {
      return new Error("real");
    }
    const frames = parser.parse(inner().stack);
    const newest = frames[frames.length - 1];
    expect(newest?.function).toBe("inner");
    expect(newest?.inApp).toBe(true);
    expect(newest?.filename).toContain("stack-parser.test.ts");
  });
});
