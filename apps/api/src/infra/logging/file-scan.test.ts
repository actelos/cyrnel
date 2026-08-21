import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tailScanLogFiles } from "@/infra/logging/file-scan";
import type { LogEntry } from "@/infra/logging/log-entry";

let tmpDir: string;

const makeEntry = (overrides: Partial<LogEntry>): LogEntry => ({
  timestamp: 0,
  seq: 0,
  level: "info",
  type: "app",
  message: "entry",
  pid: 1,
  ...overrides,
});

function writeLines(file: string, entries: LogEntry[]): void {
  fs.writeFileSync(
    file,
    `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrnel-log-scan-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("tailScanLogFiles", () => {
  it("returns newest entries from the active file in reverse order", async () => {
    const file = path.join(tmpDir, "app.log");
    writeLines(file, [
      makeEntry({ timestamp: 100, seq: 1, message: "first" }),
      makeEntry({ timestamp: 200, seq: 2, message: "second" }),
      makeEntry({ timestamp: 300, seq: 3, message: "third" }),
    ]);

    const result = await tailScanLogFiles(
      { filePath: file, maxFiles: 5 },
      {},
      10,
    );

    expect(result.map((e) => e.seq)).toEqual([3, 2, 1]);
  });

  it("scans rotated files newest first", async () => {
    const active = path.join(tmpDir, "app.log");
    writeLines(active, [
      makeEntry({ timestamp: 300, seq: 3 }),
      makeEntry({ timestamp: 400, seq: 4 }),
    ]);
    const rotated = path.join(tmpDir, "app.log.1");
    writeLines(rotated, [
      makeEntry({ timestamp: 100, seq: 1 }),
      makeEntry({ timestamp: 200, seq: 2 }),
    ]);

    const result = await tailScanLogFiles(
      { filePath: active, maxFiles: 5 },
      {},
      10,
    );

    expect(result.map((e) => e.seq)).toEqual([4, 3, 2, 1]);
  });

  it("respects the before cursor", async () => {
    const file = path.join(tmpDir, "app.log");
    writeLines(file, [
      makeEntry({ timestamp: 100, seq: 1 }),
      makeEntry({ timestamp: 200, seq: 2 }),
      makeEntry({ timestamp: 300, seq: 3 }),
    ]);

    const result = await tailScanLogFiles(
      { filePath: file, maxFiles: 5 },
      {},
      10,
      {
        timestamp: 200,
        seq: 2,
      },
    );

    expect(result.map((e) => e.seq)).toEqual([1]);
  });

  it("applies filters", async () => {
    const file = path.join(tmpDir, "app.log");
    writeLines(file, [
      makeEntry({ timestamp: 100, seq: 1, level: "info", message: "ok" }),
      makeEntry({ timestamp: 200, seq: 2, level: "error", message: "boom" }),
    ]);

    const result = await tailScanLogFiles(
      { filePath: file, maxFiles: 5 },
      { level: "error" },
      10,
    );

    expect(result.map((e) => e.message)).toEqual(["boom"]);
  });

  it("stops early once the limit is reached", async () => {
    const file = path.join(tmpDir, "app.log");
    writeLines(file, [
      makeEntry({ timestamp: 100, seq: 1 }),
      makeEntry({ timestamp: 200, seq: 2 }),
      makeEntry({ timestamp: 300, seq: 3 }),
    ]);

    const result = await tailScanLogFiles(
      { filePath: file, maxFiles: 5 },
      {},
      2,
    );

    expect(result.map((e) => e.seq)).toEqual([3, 2]);
  });

  it("skips malformed lines and missing files", async () => {
    const file = path.join(tmpDir, "app.log");
    fs.writeFileSync(
      file,
      `${JSON.stringify(makeEntry({ timestamp: 100, seq: 1 }))}\nnot-json\nnull\n[1,2,3]\n{"timestamp":200}\n${JSON.stringify(makeEntry({ timestamp: 300, seq: 2 }))}\n`,
    );

    const result = await tailScanLogFiles(
      { filePath: file, maxFiles: 5 },
      {},
      10,
    );

    expect(result.map((e) => e.seq)).toEqual([2, 1]);

    const missing = await tailScanLogFiles(
      { filePath: path.join(tmpDir, "nope.log"), maxFiles: 5 },
      {},
      10,
    );
    expect(missing).toEqual([]);
  });

  it("returns nothing for a zero limit", async () => {
    const file = path.join(tmpDir, "app.log");
    writeLines(file, [makeEntry({ timestamp: 100, seq: 1 })]);
    const result = await tailScanLogFiles(
      { filePath: file, maxFiles: 5 },
      {},
      0,
    );
    expect(result).toEqual([]);
  });
});
