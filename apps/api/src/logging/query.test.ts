import { describe, expect, it } from "vitest";

import type { LogEntry } from "@/logging/log-entry";
import {
  type LogQueryFilters,
  type LogSort,
  matchesLogFilters,
  parseLogCursor,
  queryLogEntries,
} from "@/logging/query";

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

describe("matchesLogFilters", () => {
  it("matches on time range", () => {
    const entry = makeEntry({ timestamp: 500 });
    expect(matchesLogFilters(entry, { from: 400, to: 600 })).toBe(true);
    expect(matchesLogFilters(entry, { from: 600 })).toBe(false);
    expect(matchesLogFilters(entry, { to: 400 })).toBe(false);
  });

  it("matches exact level and levelMin", () => {
    const entry = makeEntry({ level: "warn" });
    expect(matchesLogFilters(entry, { level: "warn" })).toBe(true);
    expect(matchesLogFilters(entry, { level: "info" })).toBe(false);
    expect(matchesLogFilters(entry, { levelMin: "info" })).toBe(true);
    expect(matchesLogFilters(entry, { levelMin: "error" })).toBe(false);
  });

  it("matches type", () => {
    expect(
      matchesLogFilters(makeEntry({ type: "request" }), { type: "request" }),
    ).toBe(true);
    expect(
      matchesLogFilters(makeEntry({ type: "request" }), { type: "app" }),
    ).toBe(false);
  });

  it("matches message substring case-insensitively", () => {
    const entry = makeEntry({ message: "Failed to load service" });
    expect(matchesLogFilters(entry, { query: "LOAD SERVICE" })).toBe(true);
    expect(matchesLogFilters(entry, { query: "nothing" })).toBe(false);
    expect(matchesLogFilters(entry, { query: "" })).toBe(true);
  });

  it("matches event and correlation keys", () => {
    const entry = makeEntry({
      event: "adapter-teardown-failed",
      adapterId: "github",
      serviceId: "svc",
      processId: 7,
      environmentId: "env",
      requestId: "req",
    });
    expect(matchesLogFilters(entry, { event: "adapter-teardown-failed" })).toBe(
      true,
    );
    expect(matchesLogFilters(entry, { adapterId: "github" })).toBe(true);
    expect(matchesLogFilters(entry, { serviceId: "svc" })).toBe(true);
    expect(matchesLogFilters(entry, { processId: 7 })).toBe(true);
    expect(matchesLogFilters(entry, { processId: 8 })).toBe(false);
    expect(matchesLogFilters(entry, { requestId: "req" })).toBe(true);
    expect(matchesLogFilters(entry, { environmentId: "env" })).toBe(true);
  });

  it("matches statusCode and duration range", () => {
    const entry = makeEntry({
      type: "request",
      statusCode: 500,
      durationMs: 150,
    });
    expect(matchesLogFilters(entry, { statusCode: 500 })).toBe(true);
    expect(matchesLogFilters(entry, { statusCode: 200 })).toBe(false);
    expect(
      matchesLogFilters(entry, { durationMin: 100, durationMax: 200 }),
    ).toBe(true);
    expect(matchesLogFilters(entry, { durationMin: 200 })).toBe(false);
    expect(matchesLogFilters(entry, { durationMax: 100 })).toBe(false);
  });

  it("fails duration filters for entries without durationMs", () => {
    const entry = makeEntry({});
    expect(matchesLogFilters(entry, { durationMin: 0 })).toBe(false);
    expect(matchesLogFilters(entry, { durationMax: 1000 })).toBe(false);
  });
});

describe("queryLogEntries", () => {
  const entries = [
    makeEntry({ timestamp: 100, seq: 1, level: "info", message: "first" }),
    makeEntry({ timestamp: 200, seq: 2, level: "warn", message: "second" }),
    makeEntry({ timestamp: 300, seq: 3, level: "error", message: "third" }),
  ];

  const sort: LogSort = { field: "timestamp", direction: "desc" };

  it("sorts by timestamp desc by default cursor semantics", () => {
    const { entries: result } = queryLogEntries(entries, {}, sort, 10);
    expect(result.map((e) => e.message)).toEqual(["third", "second", "first"]);
  });

  it("supports asc sort", () => {
    const { entries: result } = queryLogEntries(
      entries,
      {},
      { field: "timestamp", direction: "asc" },
      10,
    );
    expect(result.map((e) => e.message)).toEqual(["first", "second", "third"]);
  });

  it("sorts by duration", () => {
    const withDurations = [
      makeEntry({ timestamp: 1, durationMs: 50 }),
      makeEntry({ timestamp: 2, durationMs: 10 }),
    ];
    const { entries: result } = queryLogEntries(
      withDurations,
      {},
      { field: "duration", direction: "desc" },
      10,
    );
    expect(result.map((e) => e.durationMs)).toEqual([50, 10]);
  });

  it("paginates with a before cursor and excludes the cursor entry", () => {
    const { entries: page, nextCursor } = queryLogEntries(entries, {}, sort, 2);
    expect(page.map((e) => e.message)).toEqual(["third", "second"]);
    expect(nextCursor).toBe("200:2");

    const second = queryLogEntries(
      entries,
      {},
      sort,
      2,
      parseLogCursor(nextCursor!),
    );
    expect(second.entries.map((e) => e.message)).toEqual(["first"]);
    expect(second.nextCursor).toBeNull();
  });

  it("returns nextCursor null when the end is reached", () => {
    const { nextCursor } = queryLogEntries(entries, {}, sort, 10);
    expect(nextCursor).toBeNull();
  });

  it("combines filters with sorting", () => {
    const { entries: result } = queryLogEntries(
      entries,
      { levelMin: "warn" },
      sort,
      10,
    );
    expect(result.map((e) => e.message)).toEqual(["third", "second"]);
  });
});

describe("parseLogCursor", () => {
  it("parses ts:seq cursors", () => {
    expect(parseLogCursor("1234:5")).toEqual({ timestamp: 1234, seq: 5 });
  });

  it("rejects malformed cursors", () => {
    expect(() => parseLogCursor("nope")).toThrow();
    expect(() => parseLogCursor("1:2:3")).toThrow();
    expect(() => parseLogCursor("a:b")).toThrow();
  });
});

describe("filters typing", () => {
  it("accepts the full filter set", () => {
    const filters: LogQueryFilters = {
      from: 1,
      to: 2,
      level: "warn",
      levelMin: "info",
      type: "app",
      query: "x",
      event: "y",
      requestId: "r",
      processId: 3,
      adapterId: "a",
      serviceId: "s",
      moduleId: "m",
      environmentId: "e",
      statusCode: 200,
      durationMin: 1,
      durationMax: 10,
    };
    expect(Object.keys(filters).length).toBeGreaterThan(0);
  });
});
