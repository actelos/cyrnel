import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db/client";
import { logs } from "@/db/schema";
import {
  LogService,
  persistLogLine,
  persistLogRecord,
} from "@/services/log.service";

async function resetLogsTable(): Promise<void> {
  await db.run(sql`DROP TABLE IF EXISTS logs`);
  await db.run(sql`
    CREATE TABLE logs (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      timestamp_ms integer NOT NULL,
      severity text NOT NULL,
      level integer NOT NULL,
      message text NOT NULL,
      request_method text,
      request_path text,
      status_code integer,
      raw text
    )
  `);
  await db.run(sql`CREATE INDEX logs_timestamp_idx ON logs (timestamp_ms)`);
  await db.run(sql`CREATE INDEX logs_severity_idx ON logs (severity)`);
  await db.run(sql`CREATE INDEX logs_message_idx ON logs (message)`);
}

describe("log.service", () => {
  beforeEach(async () => {
    await resetLogsTable();
  });

  it("lists and counts logs with filters", async () => {
    const service = new LogService();

    await db.insert(logs).values([
      {
        timestampMs: 1_700_000_000_000,
        severity: "info",
        level: 30,
        message: "service started",
      },
      {
        timestampMs: 1_700_000_000_100,
        severity: "error",
        level: 50,
        message: "timeout while invoking tool",
      },
      {
        timestampMs: 1_700_000_000_200,
        severity: "error",
        level: 50,
        message: "another timeout happened",
      },
    ]);

    const rows = await service.list({
      query: " TIMEOUT ".trim(),
      severity: "error",
      from: 1_700_000_000_050,
      to: 1_700_000_000_250,
      limit: 50,
      offset: 0,
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.message)).toEqual([
      "another timeout happened",
      "timeout while invoking tool",
    ]);

    const count = await service.count({
      query: "timeout",
      severity: "error",
      from: 1_700_000_000_050,
      to: 1_700_000_000_250,
    });

    expect(count).toBe(2);
  });

  it("applies pagination and deterministic ordering", async () => {
    const service = new LogService();

    await db.insert(logs).values([
      {
        timestampMs: 10,
        severity: "info",
        level: 30,
        message: "first",
      },
      {
        timestampMs: 10,
        severity: "info",
        level: 30,
        message: "second",
      },
      {
        timestampMs: 11,
        severity: "warn",
        level: 40,
        message: "third",
      },
    ]);

    const page = await service.list({
      query: undefined,
      severity: undefined,
      from: undefined,
      to: undefined,
      limit: 1,
      offset: 1,
    });

    expect(page).toHaveLength(1);
    expect(page[0]?.message).toBe("second");
  });

  it("deletes by message query and returns deleted count", async () => {
    const service = new LogService();

    await db.insert(logs).values([
      {
        timestampMs: 1,
        severity: "error",
        level: 50,
        message: "Timeout in adapter",
      },
      {
        timestampMs: 2,
        severity: "warn",
        level: 40,
        message: "timeout in transport",
      },
      {
        timestampMs: 3,
        severity: "info",
        level: 30,
        message: "all good",
      },
    ]);

    const deleted = await service.deleteByMessageQuery("TiMeOuT");

    expect(deleted).toBe(2);

    const remaining = await db
      .select({ message: logs.message })
      .from(logs)
      .orderBy(logs.id);

    expect(remaining).toEqual([{ message: "all good" }]);
  });

  it("persists structured fields from a raw record", async () => {
    await persistLogRecord({
      level: 50,
      msg: "request failed",
      time: "2026-04-26T12:00:00.000Z",
      req: { method: "GET", url: "/services" },
      res: { statusCode: 503 },
      traceId: "abc-123",
    });

    const rows = await db
      .select()
      .from(logs)
      .where(eq(logs.message, "request failed"));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      severity: "error",
      level: 50,
      message: "request failed",
      requestMethod: "GET",
      requestPath: "/services",
      statusCode: 503,
    });
    expect(rows[0]?.timestampMs).toBe(Date.parse("2026-04-26T12:00:00.000Z"));
  });

  it("parses multiple JSON log lines and ignores malformed lines", async () => {
    await persistLogLine(
      [
        '{"level":30,"time":1714132800000,"msg":"ok-1"}',
        "not-json",
        '{"level":40,"time":1714132800100,"msg":"ok-2"}',
        "",
      ].join("\n"),
    );

    const rows = await db
      .select({ message: logs.message, severity: logs.severity })
      .from(logs)
      .orderBy(logs.id);

    expect(rows).toEqual([
      { message: "ok-1", severity: "info" },
      { message: "ok-2", severity: "warn" },
    ]);
  });

  it("ignores non-object records", async () => {
    await persistLogRecord("not-an-object");

    const countRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(logs);

    expect(Number(countRows[0]?.count ?? 0)).toBe(0);
  });
});
