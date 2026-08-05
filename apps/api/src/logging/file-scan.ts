import fs from "node:fs";

import type { LogEntry } from "@/logging/log-entry";
import {
  entryIsAfterOrAtCursor,
  type LogCursor,
  type LogQueryFilters,
  matchesLogFilters,
} from "@/logging/query";

export interface LogFileOptions {
  filePath: string;
  maxFiles: number;
}

function listLogFiles({ filePath, maxFiles }: LogFileOptions): string[] {
  const files = [filePath];
  for (let index = 1; index <= maxFiles; index += 1) {
    files.push(`${filePath}.${index}`);
  }
  return files.filter((file) => fs.existsSync(file));
}

/**
 * Scans the JSONL log files (newest file first, newest line first) for
 * entries matching `filters`, strictly older than `before` when given.
 * Entries are returned in descending timestamp order (file order) and the
 * scan stops early once `limit` entries are collected.
 */
export function tailScanLogFiles(
  options: LogFileOptions,
  filters: LogQueryFilters,
  limit: number,
  before?: LogCursor,
): LogEntry[] {
  if (limit <= 0) return [];
  const out: LogEntry[] = [];
  for (const file of listLogFiles(options)) {
    if (out.length >= limit) break;
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (out.length >= limit) break;
      const line = lines[index].trim();
      if (line.length === 0) continue;
      let entry: LogEntry;
      try {
        entry = JSON.parse(line) as LogEntry;
      } catch {
        continue;
      }
      if (typeof entry.timestamp !== "number" || typeof entry.seq !== "number")
        continue;
      if (before !== undefined && entryIsAfterOrAtCursor(entry, before))
        continue;
      if (!matchesLogFilters(entry, filters)) continue;
      out.push(entry);
    }
  }
  return out;
}
