import type { Request, Response } from "express";
import { z } from "zod";
import { tailScanLogFiles } from "@/infra/logging/file-scan";
import {
  LOG_LEVELS,
  type LogEntry,
  logEntryId,
} from "@/infra/logging/log-entry";
import {
  type LogCursor,
  type LogSort,
  parseLogCursor,
  queryLogEntries,
} from "@/infra/logging/query";
import { HttpError } from "@/models/error.model";
import {
  getLogBuffer,
  getLogBus,
  getLogFileOptions,
} from "@/services/log.service";
import { parseOrHttpError } from "@/utils/validation.util";

const STREAM_REPLAY_LIMIT = 100;
const STREAM_HEARTBEAT_MS = 15_000;

const LOG_TYPES = ["app", "request"] as const;

const listLogsQuerySchema = z.object({
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  level: z.enum(LOG_LEVELS).optional(),
  levelMin: z.enum(LOG_LEVELS).optional(),
  type: z.enum(LOG_TYPES).optional(),
  query: z.string().max(500).optional(),
  event: z.string().max(200).optional(),
  requestId: z.string().max(200).optional(),
  processId: z
    .union([
      z.coerce.number().int().positive(),
      z.string().trim().min(1).max(200),
    ])
    .optional(),
  adapterId: z.string().max(200).optional(),
  serviceId: z.string().max(200).optional(),
  moduleId: z.string().max(200).optional(),
  environmentId: z.string().max(200).optional(),
  statusCode: z.coerce.number().int().positive().max(599).optional(),
  durationMin: z.coerce.number().int().nonnegative().optional(),
  durationMax: z.coerce.number().int().nonnegative().optional(),
  sort: z
    .enum(["timestamp:asc", "timestamp:desc", "duration:asc", "duration:desc"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.string().optional(),
});

type ListLogsQuery = z.infer<typeof listLogsQuerySchema>;

function parseSort(raw: string | undefined): LogSort {
  if (raw === undefined) return { field: "timestamp", direction: "desc" };
  const [field, direction] = raw.split(":") as [
    LogSort["field"],
    LogSort["direction"],
  ];
  return { field, direction };
}

export async function listLogs(req: Request, res: Response): Promise<void> {
  const query = parseOrHttpError(
    listLogsQuerySchema,
    req.query,
    "Invalid query parameters.",
  );

  let before: ReturnType<typeof parseLogCursor> | undefined;
  if (query.before !== undefined) {
    try {
      before = parseLogCursor(query.before);
    } catch {
      throw new HttpError(400, "Invalid 'before' cursor.");
    }
  }

  const sort = parseSort(query.sort);
  if (
    before !== undefined &&
    (sort.field !== "timestamp" || sort.direction !== "desc")
  ) {
    throw new HttpError(
      400,
      "'before' cursor is only supported with sort=timestamp:desc.",
    );
  }
  const buffer = getLogBuffer();
  const { entries: bufferEntries, nextCursor: bufferNextCursor } =
    queryLogEntries(
      buffer ? buffer.toArray() : [],
      toFilters(query),
      sort,
      query.limit,
      before,
    );

  const fileOptions = getLogFileOptions();
  const canScanFiles =
    fileOptions !== null &&
    sort.field === "timestamp" &&
    sort.direction === "desc" &&
    bufferEntries.length < query.limit;
  if (!canScanFiles) {
    res
      .status(200)
      .json({ entries: bufferEntries, nextCursor: bufferNextCursor });
    return;
  }

  let deepBefore: LogCursor | undefined = before;
  if (bufferEntries.length > 0) {
    const oldest = bufferEntries[bufferEntries.length - 1];
    deepBefore = { timestamp: oldest.timestamp, seq: oldest.seq };
  }

  const remaining = query.limit - bufferEntries.length;
  const deep = await tailScanLogFiles(
    fileOptions,
    toFilters(query),
    remaining,
    deepBefore,
  );
  const entries = [...bufferEntries, ...deep];
  const nextCursor =
    deep.length === remaining ? logEntryId(entries[entries.length - 1]) : null;

  res.status(200).json({ entries, nextCursor });
}

function toFilters(query: ListLogsQuery) {
  return {
    from: query.from,
    to: query.to,
    level: query.level,
    levelMin: query.levelMin,
    type: query.type,
    query: query.query,
    event: query.event,
    requestId: query.requestId,
    processId: query.processId,
    adapterId: query.adapterId,
    serviceId: query.serviceId,
    moduleId: query.moduleId,
    environmentId: query.environmentId,
    statusCode: query.statusCode,
    durationMin: query.durationMin,
    durationMax: query.durationMax,
  };
}

export function streamLogs(req: Request, res: Response): void {
  const bus = getLogBus();
  if (!bus)
    throw new HttpError(503, "Log stream unavailable (logging disabled).");

  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = bus.subscribe(sendEntry);
  } catch {
    throw new HttpError(503, "Too many log stream subscribers.");
  }

  let closed = false;

  const heartbeat = setInterval(() => {
    if (closed) return;
    try {
      res.write(": ping\n\n");
    } catch {
      cleanup();
    }
  }, STREAM_HEARTBEAT_MS);
  heartbeat.unref();

  function sendEntry(entry: LogEntry): void {
    if (closed) return;
    try {
      res.write(
        `id: ${logEntryId(entry)}\nevent: log\ndata: ${JSON.stringify(entry)}\n\n`,
      );
    } catch {
      cleanup();
    }
  }

  function cleanup(): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe?.();
    res.end();
  }

  req.on("close", cleanup);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const buffer = getLogBuffer();
  const recent = buffer ? buffer.toArray().slice(-STREAM_REPLAY_LIMIT) : [];
  for (const entry of recent) sendEntry(entry);
}
