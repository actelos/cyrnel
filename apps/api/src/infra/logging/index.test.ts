import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LogEntry } from "@/infra/logging/log-entry";
import { LogSink } from "@/infra/logging/log-sink";

const originalEnv = { ...process.env };

function resetEnv() {
  process.env = { ...originalEnv };
}

beforeEach(() => {
  resetEnv();
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  resetEnv();
});

async function importIndex() {
  return vi.importActual<typeof import("@/infra/logging/index")>(
    "@/infra/logging/index",
  );
}

describe("infra/logging/index", () => {
  describe("initLogger and closeLogger", () => {
    it("does nothing in test environment", async () => {
      process.env.NODE_ENV = "test";
      const indexModule = await importIndex();

      indexModule.initLogger();
      await indexModule.closeLogger();

      expect(indexModule.getLogBuffer()).toBeNull();
      expect(indexModule.getLogBus()).toBeNull();
      expect(indexModule.getLogFileOptions()).toBeNull();
    });

    it("initializes sink and returns log buffer, bus, and file options when not in test", async () => {
      process.env.NODE_ENV = "development";
      process.env.CYRNEL_LOG_FILE = "false";
      const indexModule = await importIndex();

      indexModule.initLogger();

      expect(indexModule.getLogBuffer()).not.toBeNull();
      expect(indexModule.getLogBus()).not.toBeNull();
      expect(indexModule.getLogFileOptions()).toBeNull();

      await indexModule.closeLogger();

      expect(indexModule.getLogBuffer()).toBeNull();
      expect(indexModule.getLogBus()).toBeNull();
    });

    it("can be called multiple times without error", async () => {
      process.env.NODE_ENV = "development";
      process.env.CYRNEL_LOG_FILE = "false";
      const indexModule = await importIndex();

      indexModule.initLogger();
      indexModule.initLogger();

      expect(indexModule.getLogBuffer()).not.toBeNull();

      await indexModule.closeLogger();
      await indexModule.closeLogger();
    });
  });

  describe("getLogFileOptions", () => {
    it("returns null when sink is not initialized", async () => {
      const indexModule = await importIndex();
      expect(indexModule.getLogFileOptions()).toBeNull();
    });

    it("returns null when filePath is not configured", async () => {
      process.env.NODE_ENV = "development";
      process.env.CYRNEL_LOG_FILE = "false";
      const indexModule = await importIndex();

      indexModule.initLogger();
      expect(indexModule.getLogFileOptions()).toBeNull();

      await indexModule.closeLogger();
    });

    it("returns file options when sink has filePath", async () => {
      process.env.NODE_ENV = "development";
      delete process.env.CYRNEL_LOG_FILE;
      process.env.CYRNEL_DATA_DIR = "/tmp/test-logs";
      const indexModule = await importIndex();

      indexModule.initLogger();
      const options = indexModule.getLogFileOptions();

      expect(options).not.toBeNull();
      expect(options?.filePath).toContain("/tmp/test-logs/logs/app.log");
      expect(options?.maxFiles).toBe(5);

      await indexModule.closeLogger();
    });
  });

  describe("logger", () => {
    it("is a pino logger instance", async () => {
      const indexModule = await importIndex();
      expect(indexModule.logger).toBeDefined();
      expect(typeof indexModule.logger.info).toBe("function");
      expect(typeof indexModule.logger.error).toBe("function");
      expect(typeof indexModule.logger.debug).toBe("function");
    });

    it("has expected log methods", async () => {
      const indexModule = await importIndex();
      expect(typeof indexModule.logger.trace).toBe("function");
      expect(typeof indexModule.logger.debug).toBe("function");
      expect(typeof indexModule.logger.info).toBe("function");
      expect(typeof indexModule.logger.warn).toBe("function");
      expect(typeof indexModule.logger.error).toBe("function");
      expect(typeof indexModule.logger.fatal).toBe("function");
    });
  });

  describe("LogSink integration", () => {
    it("writes to ring buffer and emits to bus", async () => {
      process.env.NODE_ENV = "development";
      process.env.CYRNEL_LOG_FILE = "false";
      await importIndex();

      const sink = new LogSink({
        rotationBytes: 0,
        maxFiles: 5,
        ringCapacity: 100,
        dedupeWindowMs: 0,
      });

      const seen: LogEntry[] = [];
      sink.bus.subscribe((entry) => seen.push(entry));

      sink.write(
        JSON.stringify({
          time: Date.now(),
          level: 30,
          msg: "test message",
          pid: process.pid,
          hostname: "test",
          v: 1,
        }),
      );

      await sink.close();

      expect(sink.buffer.size).toBe(1);
      expect(seen).toHaveLength(1);
      expect(seen[0].message).toBe("test message");
    });
  });

  describe("module-logger re-exports", () => {
    it("re-exports createModuleLogger", async () => {
      const indexModule = await importIndex();
      expect(typeof indexModule.createModuleLogger).toBe("function");
    });
  });
});
