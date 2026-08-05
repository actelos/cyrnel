import { describe, expect, it } from "vitest";

import { logEntryId, normalizeLogObject } from "@/logging/log-entry";

function rawLog(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    time: 1_700_000_000_000,
    level: 30,
    msg: "a message",
    pid: 42,
    hostname: "test-host",
    v: 1,
    ...overrides,
  };
}

describe("normalizeLogObject", () => {
  it("maps pino fields to the canonical vocabulary", () => {
    const entry = normalizeLogObject(rawLog({}), 7);
    expect(entry).toMatchObject({
      timestamp: 1_700_000_000_000,
      seq: 7,
      level: "info",
      type: "app",
      message: "a message",
      pid: 42,
    });
    expect(entry.metadata).toBeUndefined();
  });

  it("maps pino level numbers to level names", () => {
    expect(normalizeLogObject(rawLog({ level: 10 }), 1).level).toBe("trace");
    expect(normalizeLogObject(rawLog({ level: 20 }), 1).level).toBe("debug");
    expect(normalizeLogObject(rawLog({ level: 40 }), 1).level).toBe("warn");
    expect(normalizeLogObject(rawLog({ level: 50 }), 1).level).toBe("error");
    expect(normalizeLogObject(rawLog({ level: 60 }), 1).level).toBe("fatal");
  });

  it("classifies request logs and flattens req/res fields", () => {
    const entry = normalizeLogObject(
      rawLog({
        req: { id: "abc123", method: "GET", url: "/processes?limit=10" },
        res: { statusCode: 200 },
        responseTime: 12.5,
      }),
      1,
    );
    expect(entry.type).toBe("request");
    expect(entry.requestId).toBe("abc123");
    expect(entry.method).toBe("GET");
    expect(entry.path).toBe("/processes");
    expect(entry.statusCode).toBe(200);
    expect(entry.durationMs).toBe(12.5);
  });

  it("maps method/url/statusCode on app logs and strips query strings", () => {
    const entry = normalizeLogObject(
      rawLog({ method: "POST", url: "/services?foo=bar", statusCode: 500 }),
      1,
    );
    expect(entry.type).toBe("app");
    expect(entry.method).toBe("POST");
    expect(entry.path).toBe("/services");
    expect(entry.statusCode).toBe(500);
  });

  it("keeps correlation keys and event", () => {
    const entry = normalizeLogObject(
      rawLog({
        event: "adapter-teardown-failed",
        adapterId: "github",
        serviceId: "svc",
        moduleId: "mod",
        environmentId: "env",
        processId: 5,
      }),
      1,
    );
    expect(entry.event).toBe("adapter-teardown-failed");
    expect(entry.adapterId).toBe("github");
    expect(entry.serviceId).toBe("svc");
    expect(entry.moduleId).toBe("mod");
    expect(entry.environmentId).toBe("env");
    expect(entry.processId).toBe(5);
  });

  it("renames err to error", () => {
    const entry = normalizeLogObject(
      rawLog({ err: { type: "Error", message: "boom" } }),
      1,
    );
    expect(entry.error).toEqual({ type: "Error", message: "boom" });
  });

  it("keeps suppressedCount", () => {
    const entry = normalizeLogObject(rawLog({ suppressedCount: 3 }), 1);
    expect(entry.suppressedCount).toBe(3);
  });

  it("collects unknown fields into metadata", () => {
    const entry = normalizeLogObject(
      rawLog({ updated: 5, failed: 2, raw: "x" }),
      1,
    );
    expect(entry.metadata).toEqual({ updated: 5, failed: 2, raw: "x" });
  });

  it("drops hostname and pino version fields", () => {
    const entry = normalizeLogObject(rawLog({}), 1);
    expect(entry.metadata?.hostname).toBeUndefined();
    expect(entry.metadata?.v).toBeUndefined();
  });

  it("produces a stable entry id", () => {
    const entry = normalizeLogObject(rawLog({}), 7);
    expect(logEntryId(entry)).toBe("1700000000000:7");
  });
});
