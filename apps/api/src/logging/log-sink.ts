import fs from "node:fs";
import path from "node:path";
import type { Transform } from "node:stream";

import { LogBus } from "@/logging/bus";
import { type LogEntry, normalizeLogObject } from "@/logging/log-entry";
import { RingBuffer } from "@/logging/ring-buffer";
import { scrubLogObject } from "@/logging/scrub";
import { LogThrottle } from "@/logging/throttle";

export interface LogSinkOptions {
  filePath: string;
  rotationBytes: number;
  maxFiles: number;
  ringCapacity: number;
  dedupeWindowMs: number;
  prettyStream?: Transform;
  beforeReopen?: () => Promise<void>;
}

const FAILURE_WARN_INTERVAL_MS = 30_000;

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class LogSink {
  readonly buffer: RingBuffer<LogEntry>;
  readonly bus: LogBus;
  readonly filePath: string;
  readonly maxFiles: number;

  private fd: number;
  private bytes = 0;
  private currentDay: string;
  private seq = 0;
  private rotating = false;
  private draining = false;
  private queued: string[] = [];
  private closed = false;
  private lastFailureWarnAt = 0;

  private readonly throttle: LogThrottle;

  constructor(private readonly options: LogSinkOptions) {
    fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
    this.fd = fs.openSync(options.filePath, "a");
    this.filePath = options.filePath;
    this.maxFiles = options.maxFiles;
    this.currentDay = dayOf(new Date());
    this.buffer = new RingBuffer(options.ringCapacity);
    this.bus = new LogBus();
    this.throttle = new LogThrottle(options.dedupeWindowMs);
  }

  write(line: string): boolean {
    if (this.closed) return true;
    if (this.rotating) {
      this.queued.push(line);
      return true;
    }

    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const scrubbed = scrubLogObject(raw);

      if (this.options.prettyStream) {
        this.options.prettyStream.write(JSON.stringify(scrubbed));
      }

      const entry = normalizeLogObject(scrubbed, ++this.seq);
      if (!this.throttle.shouldEmit(entry, Date.now())) return true;

      this.buffer.push(entry);
      this.bus.emit(entry);
      this.appendEntry(entry);
      if (!this.draining) this.maybeRotate();
    } catch (err) {
      this.reportFailure(err);
    }
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      fs.closeSync(this.fd);
    } catch {
      // Best effort; the process is shutting down.
    }
  }

  private appendEntry(entry: LogEntry): void {
    const line = `${JSON.stringify(entry)}\n`;
    fs.writeSync(this.fd, line);
    this.bytes += Buffer.byteLength(line);
  }

  private maybeRotate(): void {
    const day = dayOf(new Date());
    const overSize =
      this.options.rotationBytes > 0 &&
      this.bytes >= this.options.rotationBytes;
    if (day === this.currentDay && !overSize) return;
    void this.rotate();
  }

  private async rotate(): Promise<void> {
    if (this.rotating || this.closed) return;
    this.rotating = true;
    try {
      fs.closeSync(this.fd);
      await shiftRotatedFiles(this.options.filePath, this.options.maxFiles);
      if (this.options.beforeReopen) await this.options.beforeReopen();
      if (this.closed) return;
      this.fd = fs.openSync(this.options.filePath, "a");
      this.bytes = 0;
      this.currentDay = dayOf(new Date());
    } catch (err) {
      this.reportFailure(err);
    } finally {
      this.rotating = false;
      this.drainQueue();
    }
  }

  private drainQueue(): void {
    if (this.queued.length === 0 || this.draining) return;
    const pending = this.queued;
    this.queued = [];
    this.draining = true;
    try {
      for (const line of pending) this.write(line);
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
