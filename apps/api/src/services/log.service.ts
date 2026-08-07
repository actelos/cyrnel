import { getLogBuffer, getLogBus, getLogFileOptions } from "@/infra/logging";
import { tailScanLogFiles } from "@/infra/logging/file-scan";
import { type LogEntry, logEntryId } from "@/infra/logging/log-entry";
import {
  type LogCursor,
  type LogQueryFilters,
  type LogSort,
  queryLogEntries,
} from "@/infra/logging/query";
import { HttpError } from "@/models/error.model";

export interface LogListResult {
  entries: LogEntry[];
  nextCursor: string | null;
}

export async function listLogs(
  filters: LogQueryFilters,
  sort: LogSort,
  limit: number,
  before?: LogCursor,
): Promise<LogListResult> {
  const buffer = getLogBuffer();
  const { entries: bufferEntries, nextCursor: bufferNextCursor } =
    queryLogEntries(
      buffer ? buffer.toArray() : [],
      filters,
      sort,
      limit,
      before,
    );

  const fileOptions = getLogFileOptions();
  const canScanFiles =
    fileOptions !== null &&
    sort.field === "timestamp" &&
    sort.direction === "desc" &&
    bufferEntries.length < limit;
  if (!canScanFiles) {
    return { entries: bufferEntries, nextCursor: bufferNextCursor };
  }

  let deepBefore: LogCursor | undefined = before;
  if (bufferEntries.length > 0) {
    const oldest = bufferEntries[bufferEntries.length - 1];
    deepBefore = { timestamp: oldest.timestamp, seq: oldest.seq };
  }

  const remaining = limit - bufferEntries.length;
  const deep = await tailScanLogFiles(
    fileOptions,
    filters,
    remaining,
    deepBefore,
  );
  const entries = [...bufferEntries, ...deep];
  const nextCursor =
    deep.length === remaining ? logEntryId(entries[entries.length - 1]) : null;
  return { entries, nextCursor };
}

export function recentLogs(limit: number): LogEntry[] {
  if (limit <= 0) return [];
  const buffer = getLogBuffer();
  return buffer ? buffer.toArray().slice(-limit) : [];
}

export function subscribeLogs(handler: (entry: LogEntry) => void): () => void {
  const bus = getLogBus();
  if (!bus)
    throw new HttpError(503, "Log stream unavailable (logging disabled).");
  try {
    return bus.subscribe(handler);
  } catch {
    throw new HttpError(503, "Too many log stream subscribers.");
  }
}
