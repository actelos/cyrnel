import { describe, expect, it } from "vitest";

import type { LogEntry } from "@/infra/logging/log-entry";
import { LogThrottle } from "@/infra/logging/throttle";

function makeEntry(
  level: LogEntry["level"],
  event?: string,
  message = "something failed",
): LogEntry {
  return {
    timestamp: 0,
    seq: 1,
    level,
    type: "app",
    message,
    event,
    pid: 1,
  };
}

const NOW = 1_000_000;

describe("LogThrottle", () => {
  it("emits everything when the window is 0", () => {
    const throttle = new LogThrottle(0);
    expect(throttle.shouldEmit(makeEntry("error"), NOW)).toBe(true);
    expect(throttle.shouldEmit(makeEntry("error"), NOW + 1)).toBe(true);
  });

  it("suppresses repeats within the window", () => {
    const throttle = new LogThrottle(1000);
    expect(throttle.shouldEmit(makeEntry("warn", "x-failed"), NOW)).toBe(true);
    expect(throttle.shouldEmit(makeEntry("warn", "x-failed"), NOW + 10)).toBe(
      false,
    );
    expect(throttle.shouldEmit(makeEntry("warn", "x-failed"), NOW + 500)).toBe(
      false,
    );
  });

  it("emits once after the window expires with the suppressed count", () => {
    const throttle = new LogThrottle(1000);
    throttle.shouldEmit(makeEntry("error", "x-failed"), NOW);
    throttle.shouldEmit(makeEntry("error", "x-failed"), NOW + 10);
    throttle.shouldEmit(makeEntry("error", "x-failed"), NOW + 20);

    const entry = makeEntry("error", "x-failed");
    expect(throttle.shouldEmit(entry, NOW + 1001)).toBe(true);
    expect(entry.suppressedCount).toBe(2);
  });

  it("does not accumulate suppressed count across windows", () => {
    const throttle = new LogThrottle(1000);
    throttle.shouldEmit(makeEntry("error", "x-failed"), NOW);
    throttle.shouldEmit(makeEntry("error", "x-failed"), NOW + 10);

    const first = makeEntry("error", "x-failed");
    throttle.shouldEmit(first, NOW + 1001);
    expect(first.suppressedCount).toBe(1);

    const second = makeEntry("error", "x-failed");
    expect(throttle.shouldEmit(second, NOW + 2001)).toBe(true);
    expect(second.suppressedCount).toBeUndefined();
  });

  it("dedupes by event and message separately", () => {
    const throttle = new LogThrottle(1000);
    expect(throttle.shouldEmit(makeEntry("warn", "a-failed"), NOW)).toBe(true);
    expect(throttle.shouldEmit(makeEntry("warn", "b-failed"), NOW + 10)).toBe(
      true,
    );
    expect(throttle.shouldEmit(makeEntry("warn", "a-failed"), NOW + 20)).toBe(
      false,
    );
  });

  it("never dedupes info or debug logs", () => {
    const throttle = new LogThrottle(1000);
    expect(throttle.shouldEmit(makeEntry("info"), NOW)).toBe(true);
    expect(throttle.shouldEmit(makeEntry("info"), NOW + 10)).toBe(true);
    expect(throttle.shouldEmit(makeEntry("debug"), NOW + 20)).toBe(true);
  });

  it("evicts the oldest keys when the tracked set exceeds the cap", () => {
    const throttle = new LogThrottle(1000);
    for (let i = 0; i < 1030; i++) {
      expect(throttle.shouldEmit(makeEntry("error", `evt-${i}`), NOW)).toBe(
        true,
      );
    }
    expect(throttle.shouldEmit(makeEntry("error", "evt-0"), NOW + 1)).toBe(
      true,
    );
  });
});
