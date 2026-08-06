import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LogSink, type LogSinkOptions } from "@/infra/logging/log-sink";

const tempDirs: string[] = [];

interface TestSink {
  sink: LogSink;
  filePath: string;
  dir: string;
}

function makeSink(overrides: Partial<LogSinkOptions> = {}): TestSink {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrnel-log-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "app.log");
  const sink = new LogSink({
    filePath,
    rotationBytes: 0,
    maxFiles: 5,
    ringCapacity: 100,
    dedupeWindowMs: 0,
    ...overrides,
  });
  return { sink, filePath, dir };
}

function pinoLine(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    time: Date.now(),
    level: 30,
    msg: "a message",
    pid: process.pid,
    hostname: "test-host",
    v: 1,
    ...overrides,
  });
}

function readAllLines(filePath: string, maxFiles: number): string[] {
  const lines: string[] = [];
  const files = [
    filePath,
    ...Array.from({ length: maxFiles }, (_, i) => `${filePath}.${i + 1}`),
  ];
  for (const file of files) {
    if (fs.existsSync(file)) {
      lines.push(
        ...fs
          .readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => line.length > 0),
      );
    }
  }
  return lines;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("LogSink", () => {
  it("writes normalized entries to the file as JSONL", async () => {
    const { sink, filePath } = makeSink();
    sink.write(pinoLine({ msg: "hello" }));
    await sink.close();

    const lines = readAllLines(filePath, 5);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({
      message: "hello",
      type: "app",
      level: "info",
    });
    expect(parsed.hostname).toBeUndefined();
    expect(parsed.v).toBeUndefined();
  });

  it("classifies request logs into the ring buffer", async () => {
    const { sink } = makeSink();
    sink.write(
      pinoLine({
        req: {
          id: "req-1",
          method: "GET",
          url: "/tools?x=1",
          headers: { host: "example.com", authorization: "Bearer sekrit" },
        },
        res: { statusCode: 404, headers: { "content-type": "text/plain" } },
        responseTime: 3,
      }),
    );
    await sink.close();
    expect(sink.buffer.size).toBe(1);
    const entry = sink.buffer.toArray()[0];
    expect(entry).toMatchObject({
      type: "request",
      requestId: "req-1",
      method: "GET",
      path: "/tools",
      statusCode: 404,
      durationMs: 3,
    });
    expect(entry.req).toEqual({
      id: "req-1",
      method: "GET",
      url: "/tools?x=1",
      headers: {
        host: "example.com",
        authorization: "***REDACTED***",
      },
    });
    expect(entry.res).toEqual({
      statusCode: 404,
      headers: { "content-type": "text/plain" },
    });
  });

  it("increments seq across entries", async () => {
    const { sink } = makeSink();
    sink.write(pinoLine({ msg: "one" }));
    sink.write(pinoLine({ msg: "two" }));
    await sink.close();
    const entries = sink.buffer.toArray();
    expect(entries[0].seq).toBe(1);
    expect(entries[1].seq).toBe(2);
  });

  it("emits entries to bus subscribers", async () => {
    const { sink } = makeSink();
    const seen: string[] = [];
    sink.bus.subscribe((entry) => seen.push(entry.message));
    sink.write(pinoLine({ msg: "bus-msg" }));
    await sink.close();
    expect(seen).toEqual(["bus-msg"]);
  });

  it("enforces the subscriber cap and allows unsubscribe", async () => {
    const { sink } = makeSink();
    const unsubscribers: Array<() => void> = [];
    for (let i = 0; i < 32; i++) {
      unsubscribers.push(sink.bus.subscribe(() => {}));
    }
    expect(() => sink.bus.subscribe(() => {})).toThrow();
    unsubscribers[0]();
    sink.bus.subscribe(() => {});
    expect(sink.bus.subscriberCount).toBe(32);
    await sink.close();
  });

  it("rotates by size and preserves every line across files", async () => {
    const { sink, filePath } = makeSink({
      rotationBytes: 2_000,
      maxFiles: 5,
      ringCapacity: 10_000,
    });
    const count = 50;
    for (let i = 0; i < count; i++) {
      sink.write(pinoLine({ msg: `message-${String(i).padStart(4, "0")}` }));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    await sink.close();

    const lines = readAllLines(filePath, 5);
    expect(lines).toHaveLength(count);
    const messages = lines.map((line) => JSON.parse(line).message).sort();
    expect(messages[0]).toBe("message-0000");
    expect(messages[count - 1]).toBe(
      `message-${String(count - 1).padStart(4, "0")}`,
    );
  });

  it("keeps writes queued during rotation without loss or misplacement", async () => {
    let releaseReopen: (() => void) | undefined;
    const reopenGate = new Promise<void>((resolve) => {
      releaseReopen = resolve;
    });
    const { sink, filePath } = makeSink({
      rotationBytes: 1_000,
      maxFiles: 5,
      ringCapacity: 10_000,
      beforeReopen: () => reopenGate,
    });
    const count = 60;
    for (let i = 0; i < count; i++) {
      sink.write(pinoLine({ msg: `queued-${String(i).padStart(4, "0")}` }));
    }
    releaseReopen?.();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await sink.close();

    const lines = readAllLines(filePath, 5);
    expect(lines).toHaveLength(count);
    const messages = lines.map((line) => JSON.parse(line).message).sort();
    expect(messages[0]).toBe("queued-0000");
    expect(messages[count - 1]).toBe(
      `queued-${String(count - 1).padStart(4, "0")}`,
    );
  });

  it("prunes rotated files beyond maxFiles", async () => {
    const { sink, dir } = makeSink({
      rotationBytes: 64,
      maxFiles: 2,
      ringCapacity: 100,
    });
    for (let i = 0; i < 40; i++) {
      sink.write(pinoLine({ msg: `prune-${i}` }));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    await sink.close();

    const files = fs.readdirSync(dir).sort();
    expect(files).toContain("app.log");
    expect(files).toContain("app.log.1");
    expect(files).toContain("app.log.2");
    expect(files).not.toContain("app.log.3");
  });

  it("never writes scrubbed secrets to the file", async () => {
    const { sink, filePath } = makeSink();
    sink.write(
      pinoLine({ msg: "token=supersecretvalue1234567890 failed", level: 40 }),
    );
    await sink.close();

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).not.toContain("supersecretvalue1234567890");
    expect(content).toContain("***REDACTED***");
  });

  it("writes 10k entries quickly with no loss", async () => {
    const { sink, filePath } = makeSink({ ringCapacity: 10_000 });
    const started = performance.now();
    for (let i = 0; i < 10_000; i++) {
      sink.write(pinoLine({ msg: `bulk-${i}` }));
    }
    const elapsed = performance.now() - started;
    await sink.close();

    expect(sink.buffer.size).toBe(10_000);
    const lines = readAllLines(filePath, 5);
    expect(lines).toHaveLength(10_000);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("keeps buffering and streaming when no file is configured", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrnel-log-"));
    tempDirs.push(dir);
    const sink = new LogSink({
      rotationBytes: 0,
      maxFiles: 5,
      ringCapacity: 100,
      dedupeWindowMs: 0,
    });
    const seen: string[] = [];
    sink.bus.subscribe((entry) => seen.push(entry.message));
    sink.write(pinoLine({ msg: "mem-only" }));
    await sink.close();

    expect(sink.filePath).toBeNull();
    expect(sink.buffer.size).toBe(1);
    expect(seen).toEqual(["mem-only"]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("recovers the file descriptor when rotation fails mid-way", async () => {
    const { sink, filePath } = makeSink({
      rotationBytes: 1_000,
      beforeReopen: () => Promise.reject(new Error("reopen blocked")),
    });
    for (let i = 0; i < 30; i++) {
      sink.write(pinoLine({ msg: `pre-${String(i).padStart(3, "0")}` }));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    sink.write(pinoLine({ msg: "after-recovery" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await sink.close();

    const lines = readAllLines(filePath, 5);
    expect(lines).toHaveLength(31);
    const messages = lines.map((line) => JSON.parse(line).message);
    expect(messages).toContain("after-recovery");
  });

  it("flushes queued lines at close during an in-flight rotation", async () => {
    let releaseReopen: (() => void) | undefined;
    const reopenGate = new Promise<void>((resolve) => {
      releaseReopen = resolve;
    });
    const { sink, filePath } = makeSink({
      rotationBytes: 1_000,
      maxFiles: 5,
      ringCapacity: 10_000,
      beforeReopen: () => reopenGate,
    });
    for (let i = 0; i < 30; i++) {
      sink.write(pinoLine({ msg: `queued-${String(i).padStart(3, "0")}` }));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closePromise = sink.close();
    releaseReopen?.();
    await closePromise;

    const lines = readAllLines(filePath, 5);
    expect(lines).toHaveLength(30);
    const messages = lines.map((line) => JSON.parse(line).message).sort();
    expect(messages[0]).toBe("queued-000");
    expect(messages[29]).toBe("queued-029");
  });
});
