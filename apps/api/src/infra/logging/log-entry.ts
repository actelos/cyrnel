import { MODULE_LOG_LEVELS } from "@cyrnel/sdk";
import { z } from "zod";

/**
 * Allowed log severity levels, lowest to highest.
 */
export const LOG_LEVELS = MODULE_LOG_LEVELS;

export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Log entry categories.
 */
export const LOG_TYPES = ["app", "request", "module"] as const;

export type LogType = (typeof LOG_TYPES)[number];

/**
 * Creates a fresh log entry schema instance. Schema instances built
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
    level: z.enum(LOG_LEVELS).describe("Log severity level."),
    type: z
      .enum(LOG_TYPES)
      .describe(
        "Entry category: 'app' for API logs, 'request' for HTTP request logs, 'module' for module-emitted logs.",
      ),
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
    moduleType: z.enum(["adapter", "environment"]).optional(),
    environmentId: z.string().optional(),
    executionId: z.number().int().optional(),
    dispatchId: z.string().optional(),
    toolId: z.string().optional(),
    pid: z.number().int().describe("Process id that emitted the entry."),
    phase: z.string().optional(),
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

export const PINO_LEVEL_SEVERITY: Record<number, LogLevel> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

export const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export function logEntryId(entry: LogEntry): string {
  return `${entry.timestamp}:${entry.seq}`;
}

const RESERVED_KEYS = new Set([
  "time",
  "level",
  "type",
  "msg",
  "pid",
  "hostname",
  "v",
  "category",
  "name",
  "event",
  "requestId",
  "processId",
  "adapterId",
  "serviceId",
  "moduleId",
  "moduleType",
  "environmentId",
  "executionId",
  "dispatchId",
  "toolId",
  "phase",
  "req",
  "res",
  "responseTime",
  "err",
  "method",
  "url",
  "statusCode",
  "suppressedCount",
]);

const CORRELATION_KEYS = [
  "requestId",
  "processId",
  "adapterId",
  "serviceId",
  "moduleId",
  "environmentId",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function stripQuery(url: string): string {
  const index = url.indexOf("?");
  return index === -1 ? url : url.slice(0, index);
}

export function normalizeLogObject(
  raw: Record<string, unknown>,
  seq: number,
): LogEntry {
  const req = isRecord(raw.req) ? raw.req : undefined;
  const res = isRecord(raw.res) ? raw.res : undefined;
  const isRequest = req !== undefined && res !== undefined;
  const type =
    typeof raw.type === "string" &&
    (LOG_TYPES as readonly string[]).includes(raw.type)
      ? (raw.type as LogType)
      : isRequest
        ? "request"
        : "app";

  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!RESERVED_KEYS.has(key)) metadata[key] = value;
  }

  const entry: LogEntry = {
    timestamp: typeof raw.time === "number" ? raw.time : Date.now(),
    seq,
    level:
      typeof raw.level === "number"
        ? (PINO_LEVEL_SEVERITY[raw.level] ?? "info")
        : "info",
    type,
    message: typeof raw.msg === "string" ? raw.msg : "",
    pid: typeof raw.pid === "number" ? raw.pid : process.pid,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };

  if (typeof raw.event === "string") entry.event = raw.event;

  for (const key of CORRELATION_KEYS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (key === "processId") {
      entry.processId = typeof value === "number" ? value : String(value);
    } else if (typeof value === "string") {
      entry[key] = value;
    }
  }

  if (typeof raw.moduleType === "string") {
    entry.moduleType =
      raw.moduleType === "adapter" || raw.moduleType === "environment"
        ? raw.moduleType
        : undefined;
  }
  if (
    typeof raw.executionId === "number" &&
    Number.isInteger(raw.executionId)
  ) {
    entry.executionId = raw.executionId;
  }
  if (typeof raw.dispatchId === "string") entry.dispatchId = raw.dispatchId;
  if (typeof raw.toolId === "string") entry.toolId = raw.toolId;
  if (typeof raw.phase === "string") entry.phase = raw.phase;

  if (isRequest) {
    if (typeof req.id === "string") entry.requestId = req.id;
    if (typeof req.method === "string") entry.method = req.method;
    if (typeof req.url === "string") entry.path = stripQuery(req.url);
    if (typeof res.statusCode === "number") entry.statusCode = res.statusCode;
    if (typeof raw.responseTime === "number")
      entry.durationMs = raw.responseTime;
    entry.req = req;
    entry.res = res;
  } else {
    if (typeof raw.method === "string") entry.method = raw.method;
    if (typeof raw.url === "string") entry.path = stripQuery(raw.url);
    if (typeof raw.statusCode === "number") entry.statusCode = raw.statusCode;
  }

  if (raw.err !== undefined) entry.error = raw.err;
  if (typeof raw.suppressedCount === "number") {
    entry.suppressedCount = raw.suppressedCount;
  }

  return entry;
}
