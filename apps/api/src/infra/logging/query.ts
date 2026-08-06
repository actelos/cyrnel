import {
  LOG_LEVEL_SEVERITY,
  type LogEntry,
  type LogLevel,
  type LogType,
  logEntryId,
} from "@/infra/logging/log-entry";

export interface LogQueryFilters {
  from?: number;
  to?: number;
  level?: LogLevel;
  levelMin?: LogLevel;
  type?: LogType;
  query?: string;
  event?: string;
  requestId?: string;
  processId?: string | number;
  adapterId?: string;
  serviceId?: string;
  moduleId?: string;
  environmentId?: string;
  statusCode?: number;
  durationMin?: number;
  durationMax?: number;
}

export type LogSortField = "timestamp" | "duration";
export type LogSortDirection = "asc" | "desc";

export interface LogSort {
  field: LogSortField;
  direction: LogSortDirection;
}

export interface LogCursor {
  timestamp: number;
  seq: number;
}

export function parseLogCursor(raw: string): LogCursor {
  const parts = raw.split(":");
  if (parts.length !== 2) throw new Error("Invalid log cursor");
  const timestamp = Number(parts[0]);
  const seq = Number(parts[1]);
  if (!Number.isInteger(timestamp) || !Number.isInteger(seq)) {
    throw new Error("Invalid log cursor");
  }
  return { timestamp, seq };
}

export function matchesLogFilters(
  entry: LogEntry,
  filters: LogQueryFilters,
): boolean {
  if (filters.from !== undefined && entry.timestamp < filters.from)
    return false;
  if (filters.to !== undefined && entry.timestamp > filters.to) return false;

  if (filters.level !== undefined && entry.level !== filters.level)
    return false;
  if (
    filters.levelMin !== undefined &&
    LOG_LEVEL_SEVERITY[entry.level] < LOG_LEVEL_SEVERITY[filters.levelMin]
  )
    return false;

  if (filters.type !== undefined && entry.type !== filters.type) return false;

  if (filters.query !== undefined && filters.query.length > 0) {
    const needle = filters.query.toLowerCase();
    if (!entry.message.toLowerCase().includes(needle)) return false;
  }

  if (filters.event !== undefined && entry.event !== filters.event)
    return false;

  if (filters.requestId !== undefined && entry.requestId !== filters.requestId)
    return false;
  if (filters.processId !== undefined && entry.processId !== filters.processId)
    return false;
  if (filters.adapterId !== undefined && entry.adapterId !== filters.adapterId)
    return false;
  if (filters.serviceId !== undefined && entry.serviceId !== filters.serviceId)
    return false;
  if (filters.moduleId !== undefined && entry.moduleId !== filters.moduleId)
    return false;
  if (
    filters.environmentId !== undefined &&
    entry.environmentId !== filters.environmentId
  )
    return false;

  if (
    filters.statusCode !== undefined &&
    entry.statusCode !== filters.statusCode
  )
    return false;
  if (
    filters.durationMin !== undefined &&
    (entry.durationMs === undefined || entry.durationMs < filters.durationMin)
  )
    return false;
  if (
    filters.durationMax !== undefined &&
    (entry.durationMs === undefined || entry.durationMs > filters.durationMax)
  )
    return false;

  return true;
}

export function compareEntries(
  a: LogEntry,
  b: LogEntry,
  sort: LogSort,
): number {
  const value =
    sort.field === "duration"
      ? (a.durationMs ?? 0) - (b.durationMs ?? 0)
      : a.timestamp - b.timestamp || a.seq - b.seq;
  return sort.direction === "asc" ? value : -value;
}

export function entryIsAfterOrAtCursor(
  entry: LogEntry,
  cursor: LogCursor,
): boolean {
  return (
    entry.timestamp > cursor.timestamp ||
    (entry.timestamp === cursor.timestamp && entry.seq >= cursor.seq)
  );
}

export function queryLogEntries(
  entries: LogEntry[],
  filters: LogQueryFilters,
  sort: LogSort,
  limit: number,
  before?: LogCursor,
): { entries: LogEntry[]; nextCursor: string | null } {
  let result = entries.filter((entry) => matchesLogFilters(entry, filters));
  if (
    before !== undefined &&
    sort.field === "timestamp" &&
    sort.direction === "desc"
  ) {
    result = result.filter((entry) => !entryIsAfterOrAtCursor(entry, before));
  }
  result.sort((a, b) => compareEntries(a, b, sort));
  const page = result.slice(0, limit);
  const nextCursor =
    result.length > page.length && page.length > 0
      ? logEntryId(page[page.length - 1])
      : null;
  return { entries: page, nextCursor };
}
