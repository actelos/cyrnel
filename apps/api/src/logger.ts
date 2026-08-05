import path from "node:path";
import pino from "pino";
import pretty from "pino-pretty";
import type { LogEntry } from "@/logging/log-entry";
import { LogSink, type LogSinkOptions } from "@/logging/log-sink";
import type { RingBuffer } from "@/logging/ring-buffer";

const { NODE_ENV, LOG_LEVEL } = process.env;

const redactConfig = {
  paths: [
    "req.headers.authorization",
    "req.headers.cookie",
    'req.headers["set-cookie"]',
    "*secret*",
    "*token*",
    "*password*",
    "*passwd*",
    "*apiKey*",
    "*api_key*",
    "*authorization*",
    "*cookie*",
  ],
  censor: "***REDACTED***",
};

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const output: Record<string, unknown> = {
      type: err.name,
      message: err.message,
    };
    const code = (err as { code?: unknown }).code;
    if (code !== undefined) output.code = code;
    if (err.stack) output.stack = err.stack;
    return output;
  }
  if (err !== null && typeof err === "object") {
    return { type: "Error", ...(err as Record<string, unknown>) };
  }
  return { type: "Error", message: String(err) };
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 1) return parsed;
  console.warn(`Invalid ${name} '${raw}'; using default ${fallback}`);
  return fallback;
}

function parseNonNegativeInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  console.warn(`Invalid ${name} '${raw}'; using default ${fallback}`);
  return fallback;
}

function resolveLogSinkOptions(): LogSinkOptions {
  const dataDir = process.env.CYRNEL_DATA_DIR || ".";
  const rotationBytes =
    parsePositiveInt(
      process.env.CYRNEL_LOG_ROTATION_MB,
      10,
      "CYRNEL_LOG_ROTATION_MB",
    ) *
    1024 *
    1024;
  return {
    filePath:
      process.env.CYRNEL_LOG_FILE ?? path.join(dataDir, "logs", "app.log"),
    rotationBytes,
    maxFiles: parsePositiveInt(
      process.env.CYRNEL_LOG_MAX_FILES,
      5,
      "CYRNEL_LOG_MAX_FILES",
    ),
    ringCapacity: parsePositiveInt(
      process.env.CYRNEL_LOG_RING_BUFFER,
      10_000,
      "CYRNEL_LOG_RING_BUFFER",
    ),
    dedupeWindowMs: parseNonNegativeInt(
      process.env.CYRNEL_LOG_DEDUPE_WINDOW_MS,
      0,
      "CYRNEL_LOG_DEDUPE_WINDOW_MS",
    ),
  };
}

let sink: LogSink | null = null;

function createLogger() {
  if (NODE_ENV === "test") {
    return pino({ level: "silent" });
  }

  const options = resolveLogSinkOptions();
  if (NODE_ENV !== "production") {
    options.prettyStream = pretty({
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    });
    options.prettyStream.pipe(process.stdout);
  }

  sink = new LogSink(options);
  return pino(
    {
      level: LOG_LEVEL ?? (NODE_ENV === "production" ? "info" : "debug"),
      redact: redactConfig,
      serializers: { err: serializeError },
    },
    sink,
  );
}

export function flushLogSink(): void {
  sink?.close();
}

export function getLogBuffer(): RingBuffer<LogEntry> | null {
  return sink?.buffer ?? null;
}

export const logger = createLogger();
