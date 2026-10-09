/**
 * zod mirror of the event payload contract (build prompt §1 + CONTRACTS.md §2).
 * Strict objects: any field the server would not expect fails the test.
 */
import { z } from "zod";

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const level = z.enum(["fatal", "error", "warning", "info", "debug"]);

const contextLines = z.array(z.string().max(300)).max(5);

export const stackFrameSchema = z
  .object({
    filename: z.string().min(1),
    function: z.string().optional(),
    module: z.string().optional(),
    lineno: z.number().int().nonnegative().optional(),
    colno: z.number().int().nonnegative().optional(),
    inApp: z.boolean(),
    preContext: contextLines.optional(),
    contextLine: z.string().max(300).optional(),
    postContext: contextLines.optional(),
  })
  .strict();

export interface ExceptionShape {
  type: string;
  value: string;
  stacktrace: { frames: z.infer<typeof stackFrameSchema>[] };
  cause?: ExceptionShape;
}

export const exceptionSchema: z.ZodType<ExceptionShape> = z.lazy(() =>
  z
    .object({
      type: z.string(),
      value: z.string().max(8192),
      stacktrace: z.object({ frames: z.array(stackFrameSchema).max(100) }).strict(),
      cause: exceptionSchema.optional(),
    })
    .strict(),
);

const exceptionDepth = (e: ExceptionShape | undefined): number =>
  e ? 1 + exceptionDepth(e.cause) : 0;

export const breadcrumbSchema = z
  .object({
    timestamp: z.string(),
    type: z.enum(["default", "http", "log", "query", "navigation"]),
    category: z.string().optional(),
    message: z.string().optional(),
    level: level.optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const eventSchema = z
  .object({
    eventId: z.string().regex(UUID_V4),
    timestamp: z.iso.datetime(),
    level,
    platform: z.literal("node"),
    environment: z.string().optional(),
    release: z.string().optional(),
    serverName: z.string().optional(),
    message: z.string().max(8192).optional(),
    exception: exceptionSchema
      .refine((e) => exceptionDepth(e) <= 5, "exception.cause depth > 5")
      .optional(),
    fingerprint: z.array(z.string()).optional(),
    tags: z
      .record(z.string().max(32), z.string().max(200))
      .refine((t) => Object.keys(t).length <= 50, "too many tags")
      .optional(),
    user: z
      .object({
        id: z.string().optional(),
        email: z.string().optional(),
        username: z.string().optional(),
        ipAddress: z.string().optional(),
      })
      .strict()
      .optional(),
    request: z
      .object({
        method: z.string().optional(),
        url: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        query: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
    contexts: z
      .object({
        runtime: z.object({ name: z.string(), version: z.string() }).optional(),
        os: z.object({ name: z.string(), version: z.string().optional() }).optional(),
      })
      .catchall(z.unknown())
      .optional(),
    breadcrumbs: z.array(breadcrumbSchema).max(100).optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
    sdk: z.object({ name: z.literal("@getfaultline/node"), version: z.string().min(1) }).strict(),
  })
  .strict();

export const batchSchema = z.object({ events: z.array(eventSchema).min(1).max(50) }).strict();

export function assertConforms(event: unknown): void {
  const result = eventSchema.safeParse(event);
  if (!result.success) {
    throw new Error(
      `event does not conform to contract:\n${JSON.stringify(result.error.issues, null, 2)}`,
    );
  }
}
