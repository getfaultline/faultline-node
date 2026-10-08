import { promises as fs } from "node:fs";
import type { ISourceContextReader } from "../../application/ports";
import type { StackFrame } from "../../domain";
import { LIMITS, truncate } from "../../domain";

export interface FsSourceContextReaderOptions {
  /** Lines before/after the error line. Default 5 (contract max). */
  contextLines?: number;
  /** Files larger than this are skipped. Default 1 MB. */
  maxFileBytes?: number;
  /** Total characters kept across all cached files. Default 8 MB. */
  maxCacheChars?: number;
  /** Max number of cached files (including negative entries). Default 100. */
  maxCacheEntries?: number;
}

type CacheEntry = { lines: string[] | null; size: number };

/**
 * Reads ±N lines of source around each in-app frame. Files are cached in a size-capped LRU
 * (a Map in insertion order); unreadable / oversized files are cached as negative entries.
 */
export class FsSourceContextReader implements ISourceContextReader {
  private readonly cache = new Map<string, CacheEntry>();
  private cacheChars = 0;
  private readonly contextLines: number;
  private readonly maxFileBytes: number;
  private readonly maxCacheChars: number;
  private readonly maxCacheEntries: number;

  constructor(options: FsSourceContextReaderOptions = {}) {
    this.contextLines = Math.min(options.contextLines ?? LIMITS.contextLines, LIMITS.contextLines);
    this.maxFileBytes = options.maxFileBytes ?? 1024 * 1024;
    this.maxCacheChars = options.maxCacheChars ?? 8 * 1024 * 1024;
    this.maxCacheEntries = options.maxCacheEntries ?? 100;
  }

  async addSourceContext(frames: StackFrame[]): Promise<StackFrame[]> {
    try {
      const out: StackFrame[] = [];
      for (const frame of frames) {
        out.push(await this.enrich(frame));
      }
      return out;
    } catch {
      return frames;
    }
  }

  /** Visible for tests. */
  get cachedFiles(): string[] {
    return [...this.cache.keys()];
  }

  private async enrich(frame: StackFrame): Promise<StackFrame> {
    if (!frame.inApp || frame.lineno === undefined || frame.lineno < 1) return frame;
    const lines = await this.readLines(frame.filename);
    if (!lines) return frame;
    const idx = frame.lineno - 1;
    const line = lines[idx];
    if (line === undefined) return frame;
    const clip = (l: string) => truncate(l, LIMITS.maxContextLineLength);
    return {
      ...frame,
      preContext: lines.slice(Math.max(0, idx - this.contextLines), idx).map(clip),
      contextLine: clip(line),
      postContext: lines.slice(idx + 1, idx + 1 + this.contextLines).map(clip),
    };
  }

  private async readLines(filename: string): Promise<string[] | null> {
    const hit = this.cache.get(filename);
    if (hit) {
      // refresh LRU position
      this.cache.delete(filename);
      this.cache.set(filename, hit);
      return hit.lines;
    }
    let lines: string[] | null = null;
    try {
      const stat = await fs.stat(filename);
      if (stat.isFile() && stat.size <= this.maxFileBytes) {
        const content = await fs.readFile(filename, "utf8");
        lines = content.split(/\r?\n/);
      }
    } catch {
      lines = null;
    }
    const size = lines ? lines.reduce((n, l) => n + l.length, 0) : 0;
    this.cache.set(filename, { lines, size });
    this.cacheChars += size;
    this.evict();
    return lines;
  }

  private evict(): void {
    while (this.cache.size > this.maxCacheEntries || this.cacheChars > this.maxCacheChars) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      const entry = this.cache.get(oldest.value);
      this.cache.delete(oldest.value);
      this.cacheChars -= entry?.size ?? 0;
    }
  }
}
