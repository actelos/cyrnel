import fs from "node:fs";
import path from "node:path";
import type { Transform } from "node:stream";

import { LogBus } from "@/infra/logging/bus";
import { type LogEntry, normalizeLogObject } from "@/infra/logging/log-entry";
import { RingBuffer } from "@/infra/logging/ring-buffer";
import { scrubLogObject } from "@/infra/logging/scrub";
import { LogThrottle } from "@/infra/logging/throttle";

export interface LogSinkOptions {
  filePath?: string;
  rotationBytes: number;
  maxFiles: number;
  ringCapacity: number;
  dedupeWindowMs: number;
  prettyStream?: Transform;
  beforeReopen?: () => Promise<void>;
}

const FAILURE_WARN_INTERVAL_MS = 30_000;
const REOPEN_RETRY_MS = 5_000;

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class LogSink {
  readonly buffer: RingBuffer<LogEntry>;
  readonly bus: LogBus;
  readonly filePath: string | null;
  readonly maxFiles: number;

  private fd: number | null = null;
  private bytes = 0;
  private currentDay: string;
  private seq = 0;
  private rotating = false;
  private reopening = false;
  private lastReopenAttemptAt = 0;
  private draining = false;
  private queued: string[] = [];
  private closed = false;
  private lastFailureWarnAt = 0;

  private readonly throttle: LogThrottle;

  constructor(private readonly options: LogSinkOptions) {
    this.filePath = options.filePath ?? null;
    this.maxFiles = options.maxFiles;
    this.currentDay = dayOf(new Date());
    this.buffer = new RingBuffer(options.ringCapacity);
    this.bus = new LogBus();
    this.throttle = new LogThrottle(options.dedupeWindowMs);
    if (options.filePath !== undefined) {
      try {
        fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
        this.fd = fs.openSync(options.filePath, "a");
        this.bytes = fs.statSync(options.filePath).size;
      } catch (err) {
        this.fd = null;
        this.reportFailure(err);
      }
    }
  }

  write(line: string): boolean {
    if (this.closed) return true;
    if (this.rotating) {
      this.queued.push(line);
      return true;
    }

    try {
      this.processLine(line);
      if (!this.draining) this.maybeRotate();
    } catch (err) {
      this.reportFailure(err);
    }
    return true;
  }

  private processLine(line: string): void {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const scrubbed = scrubLogObject(raw);

    if (this.options.prettyStream) {
      this.options.prettyStream.write(JSON.stringify(scrubbed));
    }

    const entry = normalizeLogObject(scrubbed, ++this.seq);
    if (!this.throttle.shouldEmit(entry, Date.now())) return;

    this.buffer.push(entry);
    this.bus.emit(entry);
    this.appendEntry(entry);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    while (this.rotating) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (this.fd === null && this.options.filePath !== undefined) {
      try {
        this.fd = fs.openSync(this.options.filePath, "a");
      } catch {}
    }
    for (const line of this.queued.splice(0)) {
      try {
        this.processLine(line);
      } catch (err) {
        this.reportFailure(err);
      }
    }
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {}
      this.fd = null;
    }
  }

  private appendEntry(entry: LogEntry): void {
    if (this.fd === null) return;
    const line = `${JSON.stringify(entry)}\n`;
    fs.writeSync(this.fd, line);
    this.bytes += Buffer.byteLength(line);
  }

  private maybeRotate(): void {
    if (this.options.filePath === undefined) return;
    const day = dayOf(new Date());
    const overSize =
      this.options.rotationBytes > 0 &&
      this.bytes >= this.options.rotationBytes;
    if (day !== this.currentDay || overSize) {
      void this.rotate();
      return;
    }
    if (this.fd === null) this.reopen();
  }

  private reopen(): void {
    const filePath = this.options.filePath;
    if (filePath === undefined || this.reopening || this.closed) return;
    const now = Date.now();
    if (now - this.lastReopenAttemptAt < REOPEN_RETRY_MS) return;
    this.reopening = true;
    this.lastReopenAttemptAt = now;
    try {
      this.fd = fs.openSync(filePath, "a");
      this.bytes = fs.statSync(filePath).size;
    } catch (err) {
      this.reportFailure(err);
    } finally {
      this.reopening = false;
    }
  }

  private async rotate(): Promise<void> {
    if (this.rotating || this.closed) return;
    const filePath = this.options.filePath;
    if (filePath === undefined) return;
    this.rotating = true;
    try {
      if (this.fd !== null) {
        fs.closeSync(this.fd);
        this.fd = null;
      }
      await shiftRotatedFiles(filePath, this.options.maxFiles);
      if (this.options.beforeReopen) await this.options.beforeReopen();
      if (this.closed) return;
      this.fd = fs.openSync(filePath, "a");
      this.bytes = 0;
      this.currentDay = dayOf(new Date());
    } catch (err) {
      if (this.fd === null && !this.closed) {
        try {
          this.fd = fs.openSync(filePath, "a");
          this.bytes = fs.statSync(filePath).size;
        } catch {}
      }
      this.reportFailure(err);
    } finally {
      this.rotating = false;
      this.drainQueue();
    }
  }

  private drainQueue(): void {
    if (this.queued.length === 0 || this.draining || this.closed) return;
    const pending = this.queued;
    this.queued = [];
    this.draining = true;
    try {
      for (const line of pending) {
        try {
          this.processLine(line);
        } catch (err) {
          this.reportFailure(err);
        }
      }
    } finally {
      this.draining = false;
      this.maybeRotate();
    }
  }

  private reportFailure(err: unknown): void {
    const now = Date.now();
    if (now - this.lastFailureWarnAt < FAILURE_WARN_INTERVAL_MS) return;
    this.lastFailureWarnAt = now;
    console.warn(
      `[log-sink] write failed (${err instanceof Error ? err.message : String(err)}); logging continues in memory`,
    );
  }
}

async function shiftRotatedFiles(
  filePath: string,
  maxFiles: number,
): Promise<void> {
  const rotatedPath = (index: number) => `${filePath}.${index}`;
  await fs.promises.rm(rotatedPath(maxFiles), { force: true });
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    await fs.promises
      .rename(rotatedPath(index), rotatedPath(index + 1))
      .catch(() => {});
  }
  await fs.promises.rename(filePath, rotatedPath(1)).catch(() => {});
}
