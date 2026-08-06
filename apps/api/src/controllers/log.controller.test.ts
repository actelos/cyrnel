import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listLogs, streamLogs } from "@/controllers/log.controller";
import type { LogEntry } from "@/infra/logging/log-entry";
import { HttpError } from "@/models/error.model";

const mocks = vi.hoisted(() => ({
  listLogs: vi.fn(),
  recentLogs: vi.fn(),
  subscribeLogs: vi.fn(),
}));

vi.mock("@/services/log.service", () => ({
  listLogs: mocks.listLogs,
  recentLogs: mocks.recentLogs,
  subscribeLogs: mocks.subscribeLogs,
}));

const listLogsMock = mocks.listLogs;
const recentLogsMock = mocks.recentLogs;
const subscribeLogsMock = mocks.subscribeLogs;

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
  headers?: Record<string, string | undefined>;
  on: ReturnType<typeof vi.fn> & MockStreamOn;
}

const makeStreamReq = (
  query: Record<string, unknown> = {},
  headers: Record<string, string | undefined> = {},
): MockStreamRequest => {
  const req = { query, headers } as MockStreamRequest;
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

function makeUnsubscribe(): () => void {
  return vi.fn();
}

describe("log.controller listLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listLogsMock.mockResolvedValue({ entries: [], nextCursor: null });
  });

  it("returns the log service result", async () => {
    const entries = [makeEntry({ timestamp: 200, seq: 2 }), makeEntry()];
    listLogsMock.mockResolvedValue({ entries, nextCursor: null });

    const res = makeRes();
    await listLogs(makeReq(), cast(res));

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ entries, nextCursor: null });
  });

  it("passes filters and limit to the log service", async () => {
    const res = makeRes();
    await listLogs(
      makeReq({
        level: "error",
        type: "app",
        query: "FAILED",
        limit: "50",
        event: "kill-signal-failed",
        requestId: "req-1",
        statusCode: "500",
      }),
      cast(res),
    );

    expect(listLogsMock).toHaveBeenCalledWith(
      {
        from: undefined,
        to: undefined,
        level: "error",
        levelMin: undefined,
        type: "app",
        query: "FAILED",
        event: "kill-signal-failed",
        requestId: "req-1",
        processId: undefined,
        adapterId: undefined,
        serviceId: undefined,
        moduleId: undefined,
        environmentId: undefined,
        statusCode: 500,
        durationMin: undefined,
        durationMax: undefined,
      },
      { field: "timestamp", direction: "desc" },
      50,
      undefined,
    );
  });

  it("passes a parsed before cursor to the log service", async () => {
    const res = makeRes();
    await listLogs(makeReq({ before: "200:2" }), cast(res));

    expect(listLogsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      100,
      { timestamp: 200, seq: 2 },
    );
  });

  it("passes explicit sort directions to the log service", async () => {
    const res = makeRes();
    await listLogs(makeReq({ sort: "duration:asc" }), cast(res));

    expect(listLogsMock).toHaveBeenCalledWith(
      expect.anything(),
      { field: "duration", direction: "asc" },
      100,
      undefined,
    );
  });

  it("rejects malformed cursors with 400 without calling the service", async () => {
    const res = makeRes();
    await expect(
      listLogs(makeReq({ before: "nope" }), cast(res)),
    ).rejects.toThrow(/Invalid 'before' cursor/);
    expect(listLogsMock).not.toHaveBeenCalled();
  });

  it("rejects invalid query parameters with 400", async () => {
    const res = makeRes();
    await expect(
      listLogs(makeReq({ level: "loud" }), cast(res)),
    ).rejects.toThrow(/Invalid option: expected one of/);
    expect(listLogsMock).not.toHaveBeenCalled();
  });

  it("rejects before cursors with non-desc sorts", async () => {
    const res = makeRes();
    await expect(
      listLogs(makeReq({ sort: "timestamp:asc", before: "200:2" }), cast(res)),
    ).rejects.toThrow(/only supported with sort=timestamp:desc/);
    expect(listLogsMock).not.toHaveBeenCalled();
  });
});

describe("log.controller streamLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recentLogsMock.mockReturnValue([]);
    subscribeLogsMock.mockReturnValue(makeUnsubscribe());
  });

  it("sets SSE headers and replays recent entries in order", () => {
    recentLogsMock.mockReturnValue([
      makeEntry({ timestamp: 100, seq: 1, message: "first" }),
      makeEntry({ timestamp: 200, seq: 2, message: "second" }),
    ]);

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

  it("replays only entries strictly newer than Last-Event-ID", () => {
    recentLogsMock.mockReturnValue([
      makeEntry({ timestamp: 100, seq: 1 }),
      makeEntry({ timestamp: 200, seq: 2 }),
      makeEntry({ timestamp: 300, seq: 3 }),
    ]);

    const res = makeRes();
    streamLogs(
      makeStreamReq({}, { "last-event-id": "200:2" }) as unknown as Request,
      cast(res),
    );

    const writes = res.write.mock.calls.map(([chunk]) => String(chunk));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("id: 300:3");
  });

  it("replays the full window for an invalid Last-Event-ID", () => {
    recentLogsMock.mockReturnValue([
      makeEntry({ timestamp: 100, seq: 1 }),
      makeEntry({ timestamp: 200, seq: 2 }),
    ]);

    const res = makeRes();
    streamLogs(
      makeStreamReq({}, { "last-event-id": "garbage" }) as unknown as Request,
      cast(res),
    );

    const writes = res.write.mock.calls.map(([chunk]) => String(chunk));
    expect(writes).toHaveLength(2);
  });

  it("pushes live entries as SSE frames with id and event", () => {
    let emit: ((entry: LogEntry) => void) | undefined;
    subscribeLogsMock.mockImplementation(
      (handler: (entry: LogEntry) => void) => {
        emit = handler;
        return makeUnsubscribe();
      },
    );

    const res = makeRes();
    streamLogs(makeStreamReq() as unknown as Request, cast(res));
    res.write.mockClear();

    emit?.(makeEntry({ timestamp: 300, seq: 3, message: "live" }));

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

  it("unsubscribes and ends the response on client close", () => {
    const unsubscribe = makeUnsubscribe();
    subscribeLogsMock.mockReturnValue(unsubscribe);

    const res = makeRes();
    const req = makeStreamReq();
    streamLogs(req as unknown as Request, cast(res));

    req.on.closeHandler();

    expect(unsubscribe).toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
  });

  it("no longer writes entries after close", () => {
    let emit: ((entry: LogEntry) => void) | undefined;
    subscribeLogsMock.mockImplementation(
      (handler: (entry: LogEntry) => void) => {
        emit = handler;
        return makeUnsubscribe();
      },
    );

    const res = makeRes();
    const req = makeStreamReq();
    streamLogs(req as unknown as Request, cast(res));
    res.write.mockClear();
    req.on.closeHandler();

    emit?.(makeEntry({ timestamp: 300, seq: 3, message: "late" }));
    expect(res.write).not.toHaveBeenCalled();
  });

  it("rejects with 503 when logging is disabled", () => {
    subscribeLogsMock.mockImplementation(() => {
      throw new HttpError(503, "Log stream unavailable (logging disabled).");
    });
    const res = makeRes();
    expect(() => streamLogs(makeReq(), cast(res))).toThrow(/logging disabled/);
  });

  it("rejects with 503 when the subscriber limit is reached", () => {
    subscribeLogsMock.mockImplementation(() => {
      throw new HttpError(503, "Too many log stream subscribers.");
    });
    const res = makeRes();
    expect(() => streamLogs(makeReq(), cast(res))).toThrow(
      /Too many log stream subscribers/,
    );
  });
});
