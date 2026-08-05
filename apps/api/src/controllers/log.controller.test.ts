import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listLogs, streamLogs } from "@/controllers/log.controller";
import { LogBus } from "@/logging/bus";
import type { LogEntry } from "@/logging/log-entry";
import { RingBuffer } from "@/logging/ring-buffer";

const mocks = vi.hoisted(() => ({
  getLogBuffer: vi.fn(),
  getLogBus: vi.fn(),
}));

vi.mock("@/logger", () => ({
  getLogBuffer: mocks.getLogBuffer,
  getLogBus: mocks.getLogBus,
}));

const getLogBufferMock = mocks.getLogBuffer;
const getLogBusMock = mocks.getLogBus;

interface MockResponse {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  writeHead: ReturnType<typeof vi.fn>;
  flushHeaders: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

const makeRes = (): MockResponse => {
  const res = {} as MockResponse;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.writeHead = vi.fn().mockReturnValue(res);
  res.flushHeaders = vi.fn();
  res.write = vi.fn().mockReturnValue(true);
  res.end = vi.fn();
  return res;
};

interface MockStreamOn {
  closeHandler: () => void;
}

interface MockStreamRequest {
  query: Record<string, unknown>;
  on: ReturnType<typeof vi.fn> & MockStreamOn;
}

const makeStreamReq = (
  query: Record<string, unknown> = {},
): MockStreamRequest => {
  const req = { query } as MockStreamRequest;
  const on = vi.fn() as MockStreamRequest["on"];
  on.mockImplementation((event: string, handler: unknown) => {
    if (event === "close") on.closeHandler = handler as () => void;
    return req;
  });
  req.on = on;
  return req;
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

describe("log.controller streamLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets SSE headers and replays recent buffer entries oldest first", () => {
    const buffer = new RingBuffer<LogEntry>(100);
    buffer.push(makeEntry({ timestamp: 100, seq: 1, message: "first" }));
    buffer.push(makeEntry({ timestamp: 200, seq: 2, message: "second" }));
    getLogBufferMock.mockReturnValue(buffer);
    const bus = new LogBus();
    getLogBusMock.mockReturnValue(bus);

    const res = makeRes();
    streamLogs(makeStreamReq() as unknown as Request, cast(res));

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    expect(res.flushHeaders).toHaveBeenCalled();
    const writes = res.write.mock.calls.map(([chunk]) => String(chunk));
    expect(writes[0]).toContain("id: 100:1");
    expect(writes[0]).toContain("first");
    expect(writes[1]).toContain("id: 200:2");
    expect(writes[1]).toContain("second");
  });

  it("pushes live entries as SSE frames with id and event", () => {
    getLogBufferMock.mockReturnValue(new RingBuffer<LogEntry>(10));
    const bus = new LogBus();
    getLogBusMock.mockReturnValue(bus);

    const res = makeRes();
    streamLogs(makeStreamReq() as unknown as Request, cast(res));
    res.write.mockClear();

    bus.emit(makeEntry({ timestamp: 300, seq: 3, message: "live" }));

    const frame = String(res.write.mock.calls[0][0]);
    expect(frame).toBe(
      "id: 300:3\nevent: log\ndata: " +
        JSON.stringify(makeEntry({ timestamp: 300, seq: 3, message: "live" })) +
        "\n\n",
    );
  });

  it("emits heartbeat comments and stops them after close", () => {
    vi.useFakeTimers();
    try {
      getLogBufferMock.mockReturnValue(new RingBuffer<LogEntry>(10));
      const bus = new LogBus();
      getLogBusMock.mockReturnValue(bus);

      const res = makeRes();
      const req = makeStreamReq();
      streamLogs(req as unknown as Request, cast(res));
      res.write.mockClear();

      vi.advanceTimersByTime(15_000);
      expect(String(res.write.mock.calls[0][0])).toBe(": ping\n\n");

      req.on.closeHandler();
      res.write.mockClear();
      vi.advanceTimersByTime(30_000);
      expect(res.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("unsubscribes from the bus and ends the response on client close", () => {
    getLogBufferMock.mockReturnValue(new RingBuffer<LogEntry>(10));
    const bus = new LogBus();
    getLogBusMock.mockReturnValue(bus);

    const res = makeRes();
    const req = makeStreamReq();
    streamLogs(req as unknown as Request, cast(res));
    expect(bus.subscriberCount).toBe(1);

    req.on.closeHandler();

    expect(bus.subscriberCount).toBe(0);
    expect(res.end).toHaveBeenCalled();
  });

  it("no longer writes entries after close", () => {
    getLogBufferMock.mockReturnValue(new RingBuffer<LogEntry>(10));
    const bus = new LogBus();
    getLogBusMock.mockReturnValue(bus);

    const res = makeRes();
    const req = makeStreamReq();
    streamLogs(req as unknown as Request, cast(res));
    res.write.mockClear();
    req.on.closeHandler();

    bus.emit(makeEntry({ timestamp: 300, seq: 3, message: "late" }));
    expect(res.write).not.toHaveBeenCalled();
  });

  it("rejects with 503 when logging is disabled", () => {
    getLogBusMock.mockReturnValue(null);
    const res = makeRes();
    expect(() => streamLogs(makeReq(), cast(res))).toThrow(/logging disabled/);
  });

  it("rejects with 503 when the subscriber limit is reached", () => {
    getLogBusMock.mockReturnValue(new LogBus(0));
    const res = makeRes();
    expect(() => streamLogs(makeReq(), cast(res))).toThrow(
      /Too many log stream subscribers/,
    );
  });
});
