import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listLogs } from "@/controllers/log.controller";
import type { LogEntry } from "@/logging/log-entry";
import { RingBuffer } from "@/logging/ring-buffer";

const mocks = vi.hoisted(() => ({ getLogBuffer: vi.fn() }));

vi.mock("@/logger", () => ({
  getLogBuffer: mocks.getLogBuffer,
}));

const getLogBufferMock = mocks.getLogBuffer;

interface MockResponse {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
}

const makeRes = (): MockResponse => {
  const res = {} as MockResponse;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

const makeReq = (query: Record<string, unknown> = {}): Request =>
  ({ query }) as unknown as Request;

const cast = (res: MockResponse) => res as unknown as Response;

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

describe("log.controller listLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns entries and nextCursor from the ring buffer", async () => {
    const buffer = new RingBuffer<LogEntry>(100);
    buffer.push(makeEntry({ timestamp: 100, seq: 1, message: "first" }));
    buffer.push(makeEntry({ timestamp: 200, seq: 2, message: "second" }));
    getLogBufferMock.mockReturnValue(buffer);

    const res = makeRes();
    await listLogs(makeReq(), cast(res));

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0] as {
      entries: LogEntry[];
      nextCursor: string | null;
    };
    expect(body.entries.map((e) => e.message)).toEqual(["second", "first"]);
    expect(body.nextCursor).toBeNull();
  });

  it("returns empty results when no sink is configured", async () => {
    getLogBufferMock.mockReturnValue(null);
    const res = makeRes();
    await listLogs(makeReq(), cast(res));
    expect(res.json).toHaveBeenCalledWith({ entries: [], nextCursor: null });
  });

  it("filters by level, type and message query", async () => {
    const buffer = new RingBuffer<LogEntry>(100);
    buffer.push(makeEntry({ seq: 1, level: "info", message: "started" }));
    buffer.push(makeEntry({ seq: 2, level: "error", message: "failed badly" }));
    getLogBufferMock.mockReturnValue(buffer);

    const res = makeRes();
    await listLogs(
      makeReq({ level: "error", type: "app", query: "FAILED" }),
      cast(res),
    );

    const body = res.json.mock.calls[0][0] as { entries: LogEntry[] };
    expect(body.entries.map((e) => e.message)).toEqual(["failed badly"]);
  });

  it("paginates with before cursor", async () => {
    const buffer = new RingBuffer<LogEntry>(100);
    buffer.push(makeEntry({ timestamp: 100, seq: 1, message: "first" }));
    buffer.push(makeEntry({ timestamp: 200, seq: 2, message: "second" }));
    buffer.push(makeEntry({ timestamp: 300, seq: 3, message: "third" }));
    getLogBufferMock.mockReturnValue(buffer);

    const res = makeRes();
    await listLogs(makeReq({ limit: 2 }), cast(res));
    const firstPage = res.json.mock.calls[0][0] as {
      entries: LogEntry[];
      nextCursor: string | null;
    };
    expect(firstPage.entries.map((e) => e.message)).toEqual([
      "third",
      "second",
    ]);
    expect(firstPage.nextCursor).toBe("200:2");

    const res2 = makeRes();
    await listLogs(makeReq({ before: "200:2" }), cast(res2));
    const secondPage = res2.json.mock.calls[0][0] as {
      entries: LogEntry[];
      nextCursor: string | null;
    };
    expect(secondPage.entries.map((e) => e.message)).toEqual(["first"]);
  });

  it("supports explicit sort directions", async () => {
    const buffer = new RingBuffer<LogEntry>(100);
    buffer.push(makeEntry({ timestamp: 100, seq: 1 }));
    buffer.push(makeEntry({ timestamp: 200, seq: 2 }));
    getLogBufferMock.mockReturnValue(buffer);

    const res = makeRes();
    await listLogs(makeReq({ sort: "timestamp:asc" }), cast(res));
    const body = res.json.mock.calls[0][0] as { entries: LogEntry[] };
    expect(body.entries.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("rejects malformed cursors with 400", async () => {
    getLogBufferMock.mockReturnValue(new RingBuffer<LogEntry>(10));
    const res = makeRes();
    await expect(
      listLogs(makeReq({ before: "nope" }), cast(res)),
    ).rejects.toThrow(/Invalid 'before' cursor/);
  });

  it("rejects invalid query parameters with 400", async () => {
    getLogBufferMock.mockReturnValue(new RingBuffer<LogEntry>(10));
    const res = makeRes();
    await expect(
      listLogs(makeReq({ level: "loud" }), cast(res)),
    ).rejects.toThrow(/Invalid option: expected one of/);
  });
});
