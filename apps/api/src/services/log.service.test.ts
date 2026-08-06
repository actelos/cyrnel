import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LogBus } from "@/infra/logging/bus";
import type { LogEntry } from "@/infra/logging/log-entry";
import { RingBuffer } from "@/infra/logging/ring-buffer";
import { listLogs, recentLogs, subscribeLogs } from "@/services/log.service";

const mocks = vi.hoisted(() => ({
  getLogBuffer: vi.fn(),
  getLogBus: vi.fn(),
  getLogFileOptions: vi.fn(),
  flushLogSink: vi.fn(),
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock("@/infra/logging/logger", () => mocks);

const getLogBufferMock = mocks.getLogBuffer;
const getLogBusMock = mocks.getLogBus;
const getLogFileOptionsMock = mocks.getLogFileOptions;

const DESC = { field: "timestamp", direction: "desc" } as const;

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrnel-log-svc-"));
  getLogFileOptionsMock.mockReturnValue(null);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: 1_000,
    seq: 1,
    level: "info",
    type: "app",
    message: "something happened",
    pid: 1,
    ...overrides,
  };
}

function bufferWith(...entries: LogEntry[]): RingBuffer<LogEntry> {
  const buffer = new RingBuffer<LogEntry>(100);
  for (const entry of entries) buffer.push(entry);
  return buffer;
}

function writeLines(filePath: string, entries: Array<LogEntry | null>): void {
  const lines = entries.map((entry) =>
    entry === null ? "null" : JSON.stringify(entry),
  );
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}

describe("log.service listLogs", () => {
  it("returns entries and nextCursor from the ring buffer", async () => {
    getLogBufferMock.mockReturnValue(
      bufferWith(
        makeEntry({ timestamp: 100, seq: 1, message: "first" }),
        makeEntry({ timestamp: 200, seq: 2, message: "second" }),
      ),
    );

    const { entries, nextCursor } = await listLogs({}, DESC, 100);

    expect(entries.map((e) => e.message)).toEqual(["second", "first"]);
    expect(nextCursor).toBeNull();
  });

  it("returns empty results when no sink is configured", async () => {
    getLogBufferMock.mockReturnValue(null);

    const result = await listLogs({}, DESC, 100);

    expect(result).toEqual({ entries: [], nextCursor: null });
  });

  it("filters by level, type and message query", async () => {
    getLogBufferMock.mockReturnValue(
      bufferWith(
        makeEntry({ seq: 1, level: "info", message: "started" }),
        makeEntry({ seq: 2, level: "error", message: "failed badly" }),
      ),
    );

    const { entries } = await listLogs(
      { level: "error", type: "app", query: "FAILED" },
      DESC,
      100,
    );

    expect(entries.map((e) => e.message)).toEqual(["failed badly"]);
  });

  it("paginates with a before cursor and excludes the cursor entry", async () => {
    getLogBufferMock.mockReturnValue(
      bufferWith(
        makeEntry({ timestamp: 100, seq: 1, message: "first" }),
        makeEntry({ timestamp: 200, seq: 2, message: "second" }),
        makeEntry({ timestamp: 300, seq: 3, message: "third" }),
      ),
    );

    const first = await listLogs({}, DESC, 2);
    expect(first.entries.map((e) => e.message)).toEqual(["third", "second"]);
    expect(first.nextCursor).toBe("200:2");

    const second = await listLogs({}, DESC, 2, {
      timestamp: 200,
      seq: 2,
    });
    expect(second.entries.map((e) => e.message)).toEqual(["first"]);
    expect(second.nextCursor).toBeNull();
  });

  it("appends file history when the buffer page is short", async () => {
    const bufferEntry = makeEntry({
      timestamp: 500,
      seq: 5,
      message: "buffer",
    });
    getLogBufferMock.mockReturnValue(bufferWith(bufferEntry));

    const filePath = path.join(tmpDir, "app.log");
    writeLines(filePath, [
      makeEntry({ timestamp: 100, seq: 1, message: "old" }),
      makeEntry({ timestamp: 200, seq: 2, message: "older" }),
      bufferEntry,
    ]);
    getLogFileOptionsMock.mockReturnValue({ filePath, maxFiles: 5 });

    const { entries, nextCursor } = await listLogs({}, DESC, 5);

    expect(entries.map((e) => e.message)).toEqual(["buffer", "older", "old"]);
    expect(nextCursor).toBeNull();
  });

  it("sets nextCursor when the file scan fills the page", async () => {
    getLogBufferMock.mockReturnValue(new RingBuffer<LogEntry>(10));

    const filePath = path.join(tmpDir, "app.log");
    writeLines(
      filePath,
      [1, 2, 3].map((n) =>
        makeEntry({ timestamp: n * 100, seq: n, message: `m${n}` }),
      ),
    );
    getLogFileOptionsMock.mockReturnValue({ filePath, maxFiles: 5 });

    const { entries, nextCursor } = await listLogs({}, DESC, 2);

    expect(entries.map((e) => e.seq)).toEqual([3, 2]);
    expect(nextCursor).toBe("200:2");
  });

  it("applies filters to the file scan", async () => {
    getLogBufferMock.mockReturnValue(new RingBuffer<LogEntry>(10));

    const filePath = path.join(tmpDir, "app.log");
    writeLines(filePath, [
      makeEntry({ timestamp: 100, seq: 1, level: "info" }),
      makeEntry({ timestamp: 200, seq: 2, level: "error" }),
    ]);
    getLogFileOptionsMock.mockReturnValue({ filePath, maxFiles: 5 });

    const { entries } = await listLogs({ level: "error" }, DESC, 10);

    expect(entries.map((e) => e.seq)).toEqual([2]);
  });

  it("continues the file scan from an explicit before cursor", async () => {
    getLogBufferMock.mockReturnValue(new RingBuffer<LogEntry>(10));

    const filePath = path.join(tmpDir, "app.log");
    writeLines(
      filePath,
      [1, 2, 3].map((n) => makeEntry({ timestamp: n * 100, seq: n })),
    );
    getLogFileOptionsMock.mockReturnValue({ filePath, maxFiles: 5 });

    const { entries, nextCursor } = await listLogs({}, DESC, 10, {
      timestamp: 300,
      seq: 3,
    });

    expect(entries.map((e) => e.seq)).toEqual([2, 1]);
    expect(nextCursor).toBeNull();
  });

  it("does not scan files for non-desc sorts", async () => {
    getLogBufferMock.mockReturnValue(new RingBuffer<LogEntry>(10));

    const filePath = path.join(tmpDir, "app.log");
    writeLines(filePath, [makeEntry({ timestamp: 100, seq: 1 })]);
    getLogFileOptionsMock.mockReturnValue({ filePath, maxFiles: 5 });

    const { entries } = await listLogs(
      {},
      { field: "timestamp", direction: "asc" },
      10,
    );

    expect(entries).toEqual([]);
  });
});

describe("log.service recentLogs", () => {
  it("returns the newest entries from the ring buffer", () => {
    getLogBufferMock.mockReturnValue(
      bufferWith(
        makeEntry({ seq: 1 }),
        makeEntry({ seq: 2 }),
        makeEntry({ seq: 3 }),
      ),
    );

    expect(recentLogs(2).map((e) => e.seq)).toEqual([2, 3]);
  });

  it("returns nothing when no sink is configured", () => {
    getLogBufferMock.mockReturnValue(null);
    expect(recentLogs(10)).toEqual([]);
  });

  it("returns nothing for a non-positive limit", () => {
    expect(recentLogs(0)).toEqual([]);
  });
});

describe("log.service subscribeLogs", () => {
  it("forwards entries from the bus", () => {
    const bus = new LogBus();
    getLogBusMock.mockReturnValue(bus);

    const seen: string[] = [];
    const unsubscribe = subscribeLogs((entry) => seen.push(entry.message));

    bus.emit(makeEntry({ message: "live" }));
    expect(seen).toEqual(["live"]);

    unsubscribe();
    bus.emit(makeEntry({ message: "late" }));
    expect(seen).toEqual(["live"]);
  });

  it("throws when logging is disabled", () => {
    getLogBusMock.mockReturnValue(null);
    expect(() => subscribeLogs(() => {})).toThrow(/logging disabled/);
  });

  it("throws when the subscriber limit is reached", () => {
    getLogBusMock.mockReturnValue(new LogBus(0));
    expect(() => subscribeLogs(() => {})).toThrow(
      /Too many log stream subscribers/,
    );
  });
});
