import type { LogEntry } from "@/infra/logging/log-entry";

interface ThrottleRecord {
  first: number;
  suppressed: number;
}

const MAX_TRACKED_KEYS = 1024;

export class LogThrottle {
  private records = new Map<string, ThrottleRecord>();

  constructor(private windowMs: number) {}

  shouldEmit(entry: LogEntry, now: number): boolean {
    if (this.windowMs <= 0) return true;
    if (entry.level !== "warn" && entry.level !== "error") return true;

    const key = `${entry.type}:${entry.event ?? entry.message}`;
    const record = this.records.get(key);

    if (record === undefined) {
      this.prune(now);
      this.records.set(key, { first: now, suppressed: 0 });
      return true;
    }

    if (now - record.first < this.windowMs) {
      record.suppressed += 1;
      return false;
    }

    record.first = now;
    if (record.suppressed > 0) {
      entry.suppressedCount = record.suppressed;
      record.suppressed = 0;
    }
    return true;
  }

  private prune(now: number): void {
    if (this.records.size < MAX_TRACKED_KEYS) return;
    for (const [key, record] of this.records) {
      if (now - record.first >= this.windowMs) this.records.delete(key);
    }
    while (this.records.size >= MAX_TRACKED_KEYS) {
      const oldest = this.records.keys().next();
      if (oldest.done) break;
      this.records.delete(oldest.value);
    }
  }
}
