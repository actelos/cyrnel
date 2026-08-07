import type { Request, Response } from "express";
import { z } from "zod";
import {
  LOG_LEVELS,
  LOG_TYPES,
  type LogEntry,
  logEntryId,
} from "@/infra/logging/log-entry";
import {
  entryIsAfterCursor,
  type LogCursor,
  type LogSort,
  parseLogCursor,
} from "@/infra/logging/query";
import { HttpError } from "@/models/error.model";
import {
  listLogs as queryLogs,
  recentLogs,
  subscribeLogs,
} from "@/services/log.service";
import {
  decodeCursor,
  encodeCursor,
  paginationQuerySchema,
} from "@/utils/pagination.util";
import { parseOrHttpError } from "@/utils/validation.util";

const STREAM_REPLAY_LIMIT = 100;
const STREAM_HEARTBEAT_MS = 15_000;

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
  ...paginationQuerySchema.shape,
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

  let before: LogCursor | undefined;
  if (query.cursor !== undefined) {
    const cursor = decodeCursor(query.cursor, 2);
    const [timestamp, seq] = cursor.sortKey;
    if (
      typeof timestamp !== "number" ||
      typeof seq !== "number" ||
      !Number.isInteger(timestamp) ||
      !Number.isInteger(seq)
    ) {
      throw new HttpError(
        400,
        "Cursor is malformed or expired; restart pagination from the first page.",
        "invalid_cursor",
      );
    }
    before = { timestamp, seq };
  }

  const sort = parseSort(query.sort);
  if (
    before !== undefined &&
    (sort.field !== "timestamp" || sort.direction !== "desc")
  ) {
    throw new HttpError(
      400,
      "Cursor is only supported with sort=timestamp:desc.",
      "invalid_cursor",
    );
  }

  const { entries, nextCursor, hasMore } = await queryLogs(
    toFilters(query),
    sort,
    query.limit,
    before,
  );
  res.status(200).json({
    items: entries,
    nextCursor: nextCursor !== null ? encodeLogCursor(nextCursor) : null,
    hasMore,
  });
}

/**
 * The log service produces cursors as raw `timestamp:seq` log-entry ids;
 * the wire format is the opaque base64url envelope shared by every other
 * paginated endpoint, so re-encode before responding.
 */
function encodeLogCursor(entryId: string): string {
  const [timestamp, seq] = entryId.split(":").map(Number);
  return encodeCursor([timestamp, seq]);
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
  const unsubscribe = subscribeLogs(sendEntry);

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

  const recent = recentLogs(STREAM_REPLAY_LIMIT);
  let replay = recent;
  const lastEventId = req.headers["last-event-id"];
  if (typeof lastEventId === "string" && lastEventId.length > 0) {
    try {
      const cursor = parseLogCursor(lastEventId);
      replay = recent.filter((entry) => entryIsAfterCursor(entry, cursor));
    } catch {
      // Invalid cursor: fall back to the full replay window.
    }
  }
  for (const entry of replay) sendEntry(entry);
}
