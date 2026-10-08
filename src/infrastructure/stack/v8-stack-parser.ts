import type { IStackParser } from "../../application/ports";
import type { StackFrame } from "../../domain";
import { LIMITS } from "../../domain";

// "    at fn (location)"  |  "    at location"
const FRAME_WITH_FN = /^\s*at (?:async )?(.+?) \((.+)\)\s*$/;
const FRAME_NO_FN = /^\s*at (?:async )?(.+?)\s*$/;
const LOCATION = /^(.*?):(\d+)(?::(\d+))?$/;
// "eval at <anonymous> (/app/x.js:1:1), <anonymous>:1:1"
const EVAL_ORIGIN = /^eval at .*?\((.+?):(\d+):(\d+)\)/;

/**
 * Parses V8 `error.stack` strings. Handles sync, async, anonymous, constructor, native,
 * eval, Windows and file:// frames. Output is ordered oldest → newest (V8 prints newest first).
 */
export class V8StackParser implements IStackParser {
  parse(stack: string | undefined): StackFrame[] {
    if (typeof stack !== "string" || stack === "") return [];
    const frames: StackFrame[] = [];
    try {
      for (const line of stack.split("\n")) {
        if (!/^\s*at /.test(line)) continue;
        const frame = parseLine(line);
        if (frame) frames.push(frame);
      }
    } catch {
      return [];
    }
    return frames.reverse().slice(-LIMITS.maxFrames);
  }
}

function parseLine(line: string): StackFrame | undefined {
  let fn: string | undefined;
  let location: string;

  const withFn = FRAME_WITH_FN.exec(line);
  if (withFn?.[1] !== undefined && withFn[2] !== undefined && looksLikeLocation(withFn[2])) {
    fn = withFn[1];
    location = withFn[2];
  } else {
    const noFn = FRAME_NO_FN.exec(line);
    if (noFn?.[1] === undefined) return undefined;
    location = noFn[1];
  }

  // eval frames: attribute to the file that called eval
  const evalMatch = EVAL_ORIGIN.exec(location);
  if (evalMatch?.[1] !== undefined) {
    const filename = normalizeFilename(evalMatch[1]);
    return finalize({
      filename,
      function: fn ?? "eval",
      lineno: Number(evalMatch[2]),
      colno: Number(evalMatch[3]),
    });
  }

  const loc = LOCATION.exec(location);
  if (loc?.[1] !== undefined && loc[2] !== undefined) {
    return finalize({
      filename: normalizeFilename(loc[1]),
      function: fn,
      lineno: Number(loc[2]),
      colno: loc[3] !== undefined ? Number(loc[3]) : undefined,
    });
  }

  // No line info: "native", "<anonymous>", "index 0" (Promise.all) …
  const filename = location === "native" || /^index \d+$/.test(location) ? "native" : location;
  return finalize({ filename, function: fn });
}

function looksLikeLocation(s: string): boolean {
  return (
    LOCATION.test(s) ||
    s.startsWith("eval at ") ||
    s === "native" ||
    s === "<anonymous>" ||
    /^index \d+$/.test(s)
  );
}

function normalizeFilename(raw: string): string {
  if (!raw.startsWith("file://")) return raw;
  let path = raw.slice("file://".length);
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep encoded */
  }
  // file:///C:/x → C:/x
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  return path;
}

function finalize(input: {
  filename: string;
  function: string | undefined;
  lineno?: number | undefined;
  colno?: number | undefined;
}): StackFrame {
  const frame: StackFrame = { filename: input.filename, inApp: false };
  const fn = cleanFunctionName(input.function);
  if (fn) frame.function = fn;
  if (input.lineno !== undefined && Number.isFinite(input.lineno)) frame.lineno = input.lineno;
  if (input.colno !== undefined && Number.isFinite(input.colno)) frame.colno = input.colno;
  const module = moduleName(input.filename);
  if (module) frame.module = module;
  frame.inApp = isInApp(input.filename, frame.lineno !== undefined);
  return frame;
}

function cleanFunctionName(fn: string | undefined): string | undefined {
  if (fn === undefined) return undefined;
  const trimmed = fn.trim();
  if (trimmed === "" || trimmed === "<anonymous>") return undefined;
  return trimmed;
}

export function isInApp(filename: string, hasLine: boolean): boolean {
  if (!hasLine) return false;
  const f = filename.replace(/\\/g, "/");
  if (f.includes("/node_modules/")) return false;
  if (f.startsWith("node:")) return false;
  if (f.startsWith("internal/")) return false; // pre-node:-prefix internals
  if (f === "<anonymous>" || f === "native") return false;
  return true;
}

/** For dependency frames: "express/lib/router/index" from ".../node_modules/express/lib/router/index.js". */
function moduleName(filename: string): string | undefined {
  const f = filename.replace(/\\/g, "/");
  const idx = f.lastIndexOf("/node_modules/");
  if (idx === -1) return undefined;
  return f.slice(idx + "/node_modules/".length).replace(/\.[cm]?[jt]sx?$/, "");
}
