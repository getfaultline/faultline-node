import { gzip as gzipCb } from "node:zlib";
import { promisify } from "node:util";
import type { ILogger, ITransport } from "../../application/ports";
import type { FaultlineEvent } from "../../domain";
import { INGEST_PATH, LIMITS, byteLength, serializeWithinLimit } from "../../domain";

const gzip = promisify(gzipCb);

export interface HttpTransportOptions {
  endpoint: string;
  apiKey: string;
  logger: ILogger;
  /** Defaults to the global fetch captured at construction (before any instrumentation). */
  fetch?: typeof fetch;
  flushIntervalMs?: number;
  flushAt?: number;
  maxQueueSize?: number;
  maxBatchSize?: number;
  maxBodyBytes?: number;
  timeoutMs?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Upper bound for honoring a 429 Retry-After. Default 10 minutes. */
  maxRetryAfterMs?: number;
  compress?: boolean;
  random?: () => number;
  now?: () => number;
}

interface QueueItem {
  eventId: string;
  json: string;
  bytes: number;
  rateLimitedAttempts: number;
}

type PostResult =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "drop"; status: number }
  | { kind: "rate-limited"; retryAfterMs: number }
  | { kind: "retry"; reason: string };

const ENVELOPE_BYTES = byteLength('{"events":[]}');

/**
 * Batched HTTP transport: in-memory queue (max 100, drop-oldest), flush every 2s or at 20
 * events, batches ≤ 50 events / ≤ 1 MB, gzip, 5s timeout, exponential backoff with jitter,
 * honors 429 Retry-After, drops on 401/413. Timers are unref'd so the SDK never keeps the
 * process alive. No method ever throws.
 */
export class HttpTransport implements ITransport {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly o: Required<
    Omit<HttpTransportOptions, "fetch" | "endpoint" | "apiKey" | "logger" | "random" | "now">
  >;
  private readonly random: () => number;
  private readonly now: () => number;
  private queue: QueueItem[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> | undefined;
  private rateLimitedUntil = 0;
  private closed = false;

  constructor(private readonly options: HttpTransportOptions) {
    this.url = options.endpoint.replace(/\/+$/, "") + INGEST_PATH;
    this.fetchImpl = options.fetch ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.o = {
      flushIntervalMs: options.flushIntervalMs ?? 2000,
      flushAt: options.flushAt ?? 20,
      maxQueueSize: options.maxQueueSize ?? 100,
      maxBatchSize: Math.min(options.maxBatchSize ?? LIMITS.maxBatchEvents, LIMITS.maxBatchEvents),
      maxBodyBytes: Math.min(options.maxBodyBytes ?? LIMITS.maxBodyBytes, LIMITS.maxBodyBytes),
      timeoutMs: options.timeoutMs ?? 5000,
      maxRetries: options.maxRetries ?? 3,
      backoffBaseMs: options.backoffBaseMs ?? 1000,
      backoffMaxMs: options.backoffMaxMs ?? 30_000,
      maxRetryAfterMs: options.maxRetryAfterMs ?? 10 * 60_000,
      compress: options.compress ?? true,
    };
  }

  get ingestUrl(): string {
    return this.url;
  }

  /** Number of events waiting to be sent (visible for tests). */
  get queueLength(): number {
    return this.queue.length;
  }

  send(event: FaultlineEvent): void {
    try {
      if (this.closed) return;
      const serialized = serializeWithinLimit(event, this.o.maxBodyBytes - ENVELOPE_BYTES);
      if (!serialized) {
        this.log.warn(`event ${event.eventId} exceeds the 1 MB body limit; dropped`);
        return;
      }
      this.queue.push({
        eventId: event.eventId,
        json: serialized.json,
        bytes: byteLength(serialized.json),
        rateLimitedAttempts: 0,
      });
      while (this.queue.length > this.o.maxQueueSize) {
        const dropped = this.queue.shift();
        this.log.debug(`queue full; dropped oldest event ${dropped?.eventId ?? "?"}`);
      }
      this.ensureTimer();
      if (this.queue.length >= this.o.flushAt) void this.drain();
    } catch (err) {
      this.log.error("transport.send failed", err);
    }
  }

  async flush(timeoutMs = 2000): Promise<boolean> {
    try {
      const deadline = this.now() + Math.max(0, timeoutMs);
      for (;;) {
        if (this.queue.length === 0 && !this.sending) return true;
        const remaining = deadline - this.now();
        if (remaining <= 0) return false;
        const limitedFor = this.rateLimitedUntil - this.now();
        if (limitedFor > 0 && !this.sending) {
          if (limitedFor >= remaining) return false;
          await sleep(limitedFor);
          continue;
        }
        await Promise.race([this.drain(), sleep(remaining)]);
      }
    } catch (err) {
      this.log.error("transport.flush failed", err);
      return false;
    }
  }

  async close(timeoutMs = 2000): Promise<boolean> {
    const ok = await this.flush(timeoutMs);
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.timer = undefined;
    this.wakeTimer = undefined;
    return ok;
  }

  // ---------------------------------------------------------------------------------------

  private get log(): ILogger {
    return this.options.logger;
  }

  private ensureTimer(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => void this.drain(), this.o.flushIntervalMs);
    this.timer.unref();
  }

  private drain(): Promise<void> {
    if (this.sending) return this.sending;
    this.sending = this.loop()
      .catch((err: unknown) => this.log.error("transport loop failed", err))
      .finally(() => {
        this.sending = undefined;
      });
    return this.sending;
  }

  private async loop(): Promise<void> {
    while (this.queue.length > 0) {
      const wait = this.rateLimitedUntil - this.now();
      if (wait > 0) {
        this.scheduleWake(wait);
        return;
      }
      const batch = this.takeBatch();
      if (batch.length === 0) return;
      await this.sendBatch(batch);
    }
  }

  private scheduleWake(ms: number): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      void this.drain();
    }, ms);
    this.wakeTimer.unref();
  }

  private takeBatch(): QueueItem[] {
    const batch: QueueItem[] = [];
    let bytes = ENVELOPE_BYTES;
    while (batch.length < this.o.maxBatchSize) {
      const next = this.queue[0];
      if (!next) break;
      const add = next.bytes + (batch.length > 0 ? 1 : 0);
      if (bytes + add > this.o.maxBodyBytes) break;
      bytes += add;
      batch.push(next);
      this.queue.shift();
    }
    return batch;
  }

  private async sendBatch(batch: QueueItem[]): Promise<void> {
    const body = `{"events":[${batch.map((i) => i.json).join(",")}]}`;
    for (let attempt = 0; ; attempt++) {
      const result = await this.post(body);
      switch (result.kind) {
        case "ok": {
          const rejected = (result.body as { rejected?: unknown } | undefined)?.rejected;
          if (Array.isArray(rejected) && rejected.length > 0) {
            this.log.debug(`server rejected ${rejected.length} event(s)`, rejected);
          }
          return;
        }
        case "drop":
          this.log.debug(
            `ingest responded ${result.status}${result.status === 401 ? " (invalid or revoked API key)" : result.status === 413 ? " (payload too large)" : ""}; dropped ${batch.length} event(s)`,
          );
          return;
        case "rate-limited": {
          this.rateLimitedUntil = this.now() + result.retryAfterMs;
          const keep = batch
            .map((i) => ({ ...i, rateLimitedAttempts: i.rateLimitedAttempts + 1 }))
            .filter((i) => i.rateLimitedAttempts <= this.o.maxRetries);
          if (keep.length < batch.length) {
            this.log.debug(`dropped ${batch.length - keep.length} event(s) after repeated 429s`);
          }
          this.queue.unshift(...keep);
          while (this.queue.length > this.o.maxQueueSize) this.queue.shift();
          this.log.debug(`rate limited; retrying after ${result.retryAfterMs}ms`);
          return;
        }
        case "retry": {
          if (attempt >= this.o.maxRetries) {
            this.log.debug(`giving up after ${attempt + 1} attempts (${result.reason}); dropped ${batch.length} event(s)`);
            return;
          }
          const delay = this.backoff(attempt);
          this.log.debug(`send failed (${result.reason}); retry #${attempt + 1} in ${delay}ms`);
          await sleep(delay);
        }
      }
    }
  }

  /** Exponential backoff with "equal jitter": half fixed, half random. */
  backoff(attempt: number): number {
    const exp = Math.min(this.o.backoffMaxMs, this.o.backoffBaseMs * 2 ** attempt);
    return Math.round(exp / 2 + this.random() * (exp / 2));
  }

  private async post(body: string): Promise<PostResult> {
    if (!this.fetchImpl) return { kind: "drop", status: 0 };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.o.timeoutMs);
    timer.unref();
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-faultline-key": this.options.apiKey,
      };
      let payload: string | Uint8Array = body;
      if (this.o.compress) {
        payload = new Uint8Array(await gzip(body));
        headers["content-encoding"] = "gzip";
      }
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        body: payload,
        signal: controller.signal,
      });
      const status = res.status;
      if (status === 429) {
        await res.body?.cancel().catch(() => undefined);
        return { kind: "rate-limited", retryAfterMs: this.parseRetryAfter(res.headers.get("retry-after")) };
      }
      if (status >= 200 && status < 300) {
        let parsed: unknown;
        try {
          parsed = await res.json();
        } catch {
          parsed = undefined;
        }
        return { kind: "ok", status, body: parsed };
      }
      await res.body?.cancel().catch(() => undefined);
      if (status >= 500 || status === 408) return { kind: "retry", reason: `HTTP ${status}` };
      return { kind: "drop", status };
    } catch (err) {
      const reason = controller.signal.aborted ? "timeout" : err instanceof Error ? err.message : "network error";
      return { kind: "retry", reason };
    } finally {
      clearTimeout(timer);
    }
  }

  private parseRetryAfter(header: string | null): number {
    const fallback = 10_000;
    if (!header) return fallback;
    const seconds = Number(header);
    let ms: number;
    if (Number.isFinite(seconds)) ms = seconds * 1000;
    else {
      const date = Date.parse(header);
      ms = Number.isNaN(date) ? fallback : date - Date.now();
    }
    return Math.min(Math.max(0, ms), this.o.maxRetryAfterMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    t.unref();
  });
}
