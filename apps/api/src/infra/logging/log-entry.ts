import {
  LOG_LEVELS,
  LOG_TYPES,
  type LogEntry,
  type LogLevel,
  type LogType,
} from "@cyrnel/sdk";

export { LOG_LEVELS, LOG_TYPES, type LogEntry, type LogLevel, type LogType };

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
  "msg",
  "pid",
  "hostname",
  "v",
  "name",
  "event",
  "requestId",
  "processId",
  "adapterId",
  "serviceId",
  "moduleId",
  "environmentId",
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
    type: isRequest ? "request" : "app",
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
