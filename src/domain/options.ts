import type { FaultlineEvent, Level, User } from "./event";
import { isLevel } from "./event";
import { LIMITS } from "./limits";

export const DEFAULT_ENDPOINT = "https://api.faultsline.dev";
export const INGEST_PATH = "/api/v1/ingest/events";

export type BeforeSend = (
  event: FaultlineEvent,
) => FaultlineEvent | null | undefined | Promise<FaultlineEvent | null | undefined>;

export interface IntegrationToggles {
  /** uncaughtException / unhandledRejection capture. Default true. */
  process?: boolean;
  /** Reserved: `Handlers.*` always work; this flag only documents intent. Default false. */
  express?: boolean;
  /** console.* calls become breadcrumbs. Default true. */
  console?: boolean;
  /** Outgoing http/https/fetch calls become breadcrumbs. Default true. */
  http?: boolean;
}

export interface FaultlineOptions {
  /** Public ingest key (`flt_ingest_...`). Required unless `enabled: false`. */
  apiKey?: string;
  endpoint?: string;
  environment?: string;
  release?: string;
  serverName?: string;
  sampleRate?: number;
  maxBreadcrumbs?: number;
  sendDefaultPii?: boolean;
  beforeSend?: BeforeSend;
  ignoreErrors?: (string | RegExp)[];
  integrations?: IntegrationToggles;
  enabled?: boolean;
  debug?: boolean;
}

export interface ResolvedOptions {
  apiKey: string;
  endpoint: string;
  environment: string | undefined;
  release: string | undefined;
  serverName: string | undefined;
  sampleRate: number;
  maxBreadcrumbs: number;
  sendDefaultPii: boolean;
  beforeSend: BeforeSend | undefined;
  ignoreErrors: (string | RegExp)[];
  integrations: Required<IntegrationToggles>;
  enabled: boolean;
  debug: boolean;
}

export interface CaptureContext {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  user?: User;
  level?: Level;
  fingerprint?: string[];
  contexts?: Record<string, Record<string, unknown>>;
}

export type OptionsResult =
  | { ok: true; options: ResolvedOptions; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[]; debug: boolean };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Hand-written options validator (ADR-002: zero runtime deps instead of zod).
 * Invalid optional fields fall back to their default with a warning; only fatal problems
 * (missing apiKey, unusable endpoint) produce `ok: false`. Never throws.
 */
export function resolveOptions(input: unknown): OptionsResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const raw: Record<string, unknown> = isPlainObject(input) ? input : {};
  if (!isPlainObject(input)) errors.push("options must be an object");

  const debug = raw.debug === true;
  const optString = (key: string, max = 200): string | undefined => {
    const v = raw[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string" || v.trim() === "") {
      warnings.push(`"${key}" must be a non-empty string; ignored`);
      return undefined;
    }
    return v.slice(0, max);
  };
  const optBool = (key: string, dflt: boolean): boolean => {
    const v = raw[key];
    if (v === undefined) return dflt;
    if (typeof v !== "boolean") {
      warnings.push(`"${key}" must be a boolean; using ${String(dflt)}`);
      return dflt;
    }
    return v;
  };

  const enabled = optBool("enabled", true);

  let apiKey = "";
  if (typeof raw.apiKey === "string" && raw.apiKey.trim() !== "") apiKey = raw.apiKey.trim();
  else if (enabled) errors.push('"apiKey" is required');

  let endpoint = DEFAULT_ENDPOINT;
  if (raw.endpoint !== undefined) {
    const parsed = parseEndpoint(raw.endpoint);
    if (parsed) endpoint = parsed;
    else errors.push('"endpoint" must be an absolute http(s) URL');
  }

  let sampleRate = 1;
  if (raw.sampleRate !== undefined) {
    const v = raw.sampleRate;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) sampleRate = v;
    else warnings.push('"sampleRate" must be a number between 0 and 1; using 1');
  }

  let maxBreadcrumbs = 50;
  if (raw.maxBreadcrumbs !== undefined) {
    const v = raw.maxBreadcrumbs;
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) {
      maxBreadcrumbs = Math.min(v, LIMITS.maxBreadcrumbs);
      if (v > LIMITS.maxBreadcrumbs)
        warnings.push(`"maxBreadcrumbs" capped at ${LIMITS.maxBreadcrumbs}`);
    } else warnings.push('"maxBreadcrumbs" must be a non-negative integer; using 50');
  }

  let beforeSend: BeforeSend | undefined;
  if (raw.beforeSend !== undefined) {
    if (typeof raw.beforeSend === "function") beforeSend = raw.beforeSend as BeforeSend;
    else warnings.push('"beforeSend" must be a function; ignored');
  }

  const ignoreErrors: (string | RegExp)[] = [];
  if (raw.ignoreErrors !== undefined) {
    if (Array.isArray(raw.ignoreErrors)) {
      for (const item of raw.ignoreErrors as unknown[]) {
        if (typeof item === "string" || item instanceof RegExp) ignoreErrors.push(item);
        else warnings.push('"ignoreErrors" entries must be strings or RegExps; entry ignored');
      }
    } else warnings.push('"ignoreErrors" must be an array; ignored');
  }

  const integrations: Required<IntegrationToggles> = {
    process: true,
    express: false,
    console: true,
    http: true,
  };
  if (raw.integrations !== undefined) {
    if (isPlainObject(raw.integrations)) {
      for (const key of Object.keys(integrations) as (keyof IntegrationToggles)[]) {
        const v = raw.integrations[key];
        if (v === undefined) continue;
        if (typeof v === "boolean") integrations[key] = v;
        else warnings.push(`"integrations.${key}" must be a boolean; using default`);
      }
    } else warnings.push('"integrations" must be an object; using defaults');
  }

  if (errors.length > 0) return { ok: false, errors, warnings, debug };

  return {
    ok: true,
    warnings,
    options: {
      apiKey,
      endpoint,
      environment: optString("environment"),
      release: optString("release"),
      serverName: optString("serverName"),
      sampleRate,
      maxBreadcrumbs,
      sendDefaultPii: optBool("sendDefaultPii", false),
      beforeSend,
      ignoreErrors,
      integrations,
      enabled,
      debug,
    },
  };
}

function parseEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

export function normalizeLevel(value: unknown, fallback: Level): Level {
  return isLevel(value) ? value : fallback;
}
