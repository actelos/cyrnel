import { and, desc, eq, gte, lte, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { logs } from "@/db/schema";
import type {
  LogQueryFilters,
  LogSeverity,
  StoredLog,
} from "@/models/log.model";

const PINO_LEVEL_TO_SEVERITY: Record<number, LogSeverity> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

export class LogService {
  async list(filters: LogQueryFilters): Promise<StoredLog[]> {
    const where = buildWhere(filters);

    const rows = await db
      .select({
        id: logs.id,
        timestampMs: logs.timestampMs,
        severity: logs.severity,
        level: logs.level,
        message: logs.message,
        requestMethod: logs.requestMethod,
        requestPath: logs.requestPath,
        statusCode: logs.statusCode,
      })
      .from(logs)
      .where(where)
      .orderBy(desc(logs.timestampMs), desc(logs.id))
      .limit(filters.limit)
      .offset(filters.offset);

    return rows as StoredLog[];
  }

  async count(
    filters: Omit<LogQueryFilters, "limit" | "offset">,
  ): Promise<number> {
    const where = buildWhere({ ...filters, limit: 1, offset: 0 });

    const rows = await db
      .select({ count: sql<number>`count(*)` })
      .from(logs)
      .where(where);

    return Number(rows[0]?.count ?? 0);
  }

  async deleteByMessageQuery(query: string): Promise<number> {
    const where = sql`lower(${logs.message}) like ${`%${query.toLowerCase()}%`}`;

    const countRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(logs)
      .where(where);

    const count = Number(countRows[0]?.count ?? 0);

    await db.delete(logs).where(where);

    return count;
  }
}

export async function persistLogRecord(raw: unknown): Promise<void> {
  if (!isRecord(raw)) {
    return;
  }

  const level = Number.isFinite(raw.level) ? Number(raw.level) : 30;
  const severity = normalizeSeverity(level);
  const message = typeof raw.msg === "string" ? raw.msg : "";
  const timestampMs = parseTimestamp(raw.time);
  const req = isRecord(raw.req) ? raw.req : null;
  const res = isRecord(raw.res) ? raw.res : null;
  const requestMethod = typeof req?.method === "string" ? req.method : null;
  const requestPath = typeof req?.url === "string" ? req.url : null;
  const statusCode = Number.isFinite(res?.statusCode)
    ? Number(res?.statusCode)
    : null;

  await db.insert(logs).values({
    timestampMs,
    severity,
    level,
    message,
    requestMethod,
    requestPath,
    statusCode,
    raw,
  });
}

export async function persistLogLine(line: string): Promise<void> {
  const trimmed = line.trim();

  if (!trimmed) {
    return;
  }

  const lines = trimmed
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  for (const current of lines) {
    try {
      const parsed = JSON.parse(current) as unknown;
      await persistLogRecord(parsed);
    } catch {
      // Ignore malformed/non-JSON lines.
    }
  }
}

function buildWhere(filters: LogQueryFilters) {
  const clauses: Array<
    | ReturnType<typeof eq>
    | ReturnType<typeof gte>
    | ReturnType<typeof lte>
    | ReturnType<typeof sql>
  > = [];

  if (filters.query) {
    clauses.push(
      sql`lower(${logs.message}) like ${`%${filters.query.toLowerCase()}%`}`,
    );
  }

  if (filters.severity) {
    clauses.push(eq(logs.severity, filters.severity));
  }

  if (filters.from !== undefined) {
    clauses.push(gte(logs.timestampMs, filters.from));
  }

  if (filters.to !== undefined) {
    clauses.push(lte(logs.timestampMs, filters.to));
  }

  if (clauses.length === 0) {
    return undefined;
  }

  if (clauses.length === 1) {
    return clauses[0];
  }

  return and(...clauses);
}

function normalizeSeverity(level: number): LogSeverity {
  if (level >= 60) {
    return "fatal";
  }

  if (level >= 50) {
    return "error";
  }

  if (level >= 40) {
    return "warn";
  }

  if (level >= 30) {
    return "info";
  }

  if (level >= 20) {
    return "debug";
  }

  if (level >= 10) {
    return "trace";
  }

  return PINO_LEVEL_TO_SEVERITY[30];
}

function parseTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
