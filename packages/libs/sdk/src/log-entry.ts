import { z } from "zod";

/**
 * Allowed log severity levels, lowest to highest.
 */
export const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Log entry categories.
 */
export const LOG_TYPES = ["app", "request"] as const;

export type LogType = (typeof LOG_TYPES)[number];

const logLevelSchema = z.enum(LOG_LEVELS);
const logTypeSchema = z.enum(LOG_TYPES);

/**
 * Creates a fresh {@link logEntrySchema} instance. Schema instances built
 * before `extendZodWithOpenApi()` runs on the zod instance lack the
 * `.openapi` helper, so callers that need it (e.g. OpenAPI generators) must
 * construct the schema after extension.
 */
export function createLogEntrySchema() {
  return z.object(buildLogEntryShape()).describe("A normalized log entry.");
}

function buildLogEntryShape() {
  return {
    timestamp: z
      .number()
      .int()
      .describe("Unix millisecond timestamp of the entry."),
    seq: z.number().int().describe("Per-sink sequence number."),
    level: logLevelSchema.describe("Log severity level."),
    type: logTypeSchema.describe("Entry category."),
    message: z.string().describe("Human-readable log message."),
    event: z
      .string()
      .optional()
      .describe("Structured event key attached by the caller."),
    requestId: z.string().optional(),
    processId: z.union([z.number(), z.string()]).optional(),
    adapterId: z.string().optional(),
    serviceId: z.string().optional(),
    moduleId: z.string().optional(),
    environmentId: z.string().optional(),
    pid: z.number().int().describe("Process id that emitted the entry."),
    method: z.string().optional(),
    path: z.string().optional(),
    statusCode: z.number().int().optional(),
    durationMs: z.number().optional(),
    req: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Normalized request object for request entries."),
    res: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Normalized response object for request entries."),
    error: z.unknown().optional(),
    suppressedCount: z.number().int().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  };
}

/**
 * Zod schema for a normalized Cyrnel log entry. The API persists entries in
 * this shape (JSONL file + ring buffer) and serves them over `GET /logs` and
 * the SSE stream; clients use this schema to parse them.
 */
export const logEntrySchema = createLogEntrySchema();

export type LogEntry = z.infer<typeof logEntrySchema>;
