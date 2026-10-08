/**
 * Event payload contract (SDK → server). Mirrors section 1 of the Faultline spec and
 * CONTRACTS.md §2 exactly — field names and enums must not drift.
 */

export const LEVELS = ["fatal", "error", "warning", "info", "debug"] as const;
export type Level = (typeof LEVELS)[number];

export const BREADCRUMB_TYPES = ["default", "http", "log", "query", "navigation"] as const;
export type BreadcrumbType = (typeof BREADCRUMB_TYPES)[number];

export const SDK_NAME = "@faultline/node" as const;

export interface StackFrame {
  filename: string;
  function?: string;
  module?: string;
  lineno?: number;
  colno?: number;
  inApp: boolean;
  preContext?: string[];
  contextLine?: string;
  postContext?: string[];
}

export interface ExceptionPayload {
  type: string;
  value: string;
  /** Frames ordered oldest → newest. */
  stacktrace: { frames: StackFrame[] };
  cause?: ExceptionPayload;
}

export interface User {
  id?: string;
  email?: string;
  username?: string;
  ipAddress?: string;
}

export interface RequestData {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

export interface Breadcrumb {
  timestamp: string;
  type: BreadcrumbType;
  category?: string;
  message?: string;
  level?: Level;
  data?: Record<string, unknown>;
}

export interface Contexts {
  runtime?: { name: string; version: string };
  os?: { name: string; version?: string };
  [key: string]: unknown;
}

export interface FaultlineEvent {
  eventId: string;
  timestamp: string;
  level: Level;
  platform: "node";
  environment?: string;
  release?: string;
  serverName?: string;
  message?: string;
  exception?: ExceptionPayload;
  fingerprint?: string[];
  tags?: Record<string, string>;
  user?: User;
  request?: RequestData;
  contexts?: Contexts;
  breadcrumbs?: Breadcrumb[];
  extra?: Record<string, unknown>;
  sdk: { name: typeof SDK_NAME; version: string };
}

export function isLevel(value: unknown): value is Level {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

export function isBreadcrumbType(value: unknown): value is BreadcrumbType {
  return typeof value === "string" && (BREADCRUMB_TYPES as readonly string[]).includes(value);
}
