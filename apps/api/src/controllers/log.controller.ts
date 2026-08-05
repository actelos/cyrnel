import type { Request, Response } from "express";
import { z } from "zod";

import { getLogBuffer } from "@/logger";
import { LOG_LEVELS } from "@/logging/log-entry";
import { type LogSort, parseLogCursor, queryLogEntries } from "@/logging/query";
import { HttpError } from "@/models/error.model";
import { parseOrHttpError } from "@/utils/validation.util";

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

  const buffer = getLogBuffer();
  const { entries, nextCursor } = queryLogEntries(
    buffer ? buffer.toArray() : [],
    toFilters(query),
    parseSort(query.sort),
    query.limit,
    before,
  );

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
