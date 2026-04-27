import type { Request, Response } from "express";
import { z } from "zod";

import { LOG_SEVERITIES, type LogSeverity } from "@/models/log.model";
import type { LogService } from "@/services/log.service";
import { parseOrHttpError } from "@/utils/validation.util";

const optionalQuerySchema = z
  .string({ error: "Field 'query' must be a string." })
  .transform((value) => value.trim())
  .transform((value) => (value.length > 0 ? value : undefined));

const requiredQuerySchema = z
  .string({ error: "Field 'query' must be a string." })
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, {
    error: "Field 'query' must not be empty.",
  });

const severitySchema = z
  .string({ error: "Field 'severity' must be a string." })
  .transform((value) => value.trim().toLowerCase())
  .refine(
    (value): value is LogSeverity => {
      return (LOG_SEVERITIES as readonly string[]).includes(value);
    },
    {
      error: `Field 'severity' must be one of ${LOG_SEVERITIES.join(", ")}.`,
    },
  );

const timestampSchema = z
  .string({ error: "Field must be a timestamp in milliseconds." })
  .regex(/^\d+$/, { error: "Field must be a timestamp in milliseconds." })
  .transform((value) => Number.parseInt(value, 10));

const limitSchema = z
  .string({ error: "Field 'limit' must be an integer between 1 and 1000." })
  .regex(/^\d+$/, {
    error: "Field 'limit' must be an integer between 1 and 1000.",
  })
  .transform((value) => Number.parseInt(value, 10))
  .refine((value) => value >= 1 && value <= 1000, {
    error: "Field 'limit' must be an integer between 1 and 1000.",
  });

const offsetSchema = z
  .string({ error: "Field 'offset' must be a non-negative integer." })
  .regex(/^\d+$/, {
    error: "Field 'offset' must be a non-negative integer.",
  })
  .transform((value) => Number.parseInt(value, 10));

export async function listLogs(req: Request, res: Response): Promise<void> {
  const logService = getLogService(req);
  const query = parseOptionalQuery(req.query.query);
  const severity = parseSeverity(req.query.severity);
  const from = parseTimestamp(req.query.from);
  const to = parseTimestamp(req.query.to);
  const limit = parseLimit(req.query.limit);
  const offset = parseOffset(req.query.offset);

  const filters = {
    query,
    severity,
    from,
    to,
    limit,
    offset,
  };

  const [logs, count] = await Promise.all([
    logService.list(filters),
    logService.count({ query, severity, from, to }),
  ]);

  res.status(200).json({ logs, count, limit, offset });
}

export async function deleteLogs(req: Request, res: Response): Promise<void> {
  const logService = getLogService(req);
  const query = parseRequiredQuery(req.query.query);
  const deleted = await logService.deleteByMessageQuery(query);

  res.status(200).json({ query, deleted });
}

function parseOptionalQuery(raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  return parseOrHttpError(optionalQuerySchema, raw);
}

function parseRequiredQuery(raw: unknown): string {
  return parseOrHttpError(requiredQuerySchema, raw);
}

function parseSeverity(raw: unknown): LogSeverity | undefined {
  if (raw === undefined) {
    return undefined;
  }

  return parseOrHttpError(severitySchema, raw);
}

function parseTimestamp(raw: unknown): number | undefined {
  if (raw === undefined) {
    return undefined;
  }

  return parseOrHttpError(timestampSchema, raw);
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) {
    return 100;
  }

  return parseOrHttpError(limitSchema, raw);
}

function parseOffset(raw: unknown): number {
  if (raw === undefined) {
    return 0;
  }

  return parseOrHttpError(offsetSchema, raw);
}

function getLogService(req: Request): LogService {
  const service = req.app.locals.logService as LogService | undefined;

  if (!service) {
    throw new Error("LogService not configured in app.locals");
  }

  return service;
}
