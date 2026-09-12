import { describe, expect, it } from "vitest";

import { LogBus } from "@/infra/logging/bus";
import type { LogEntry } from "@/infra/logging/log-entry";

function createLogEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: Date.now(),
    seq: 1,
    level: "info",
    type: "app",
    message: "test message",
    pid: process.pid,
    ...overrides,
  };
}

describe("LogBus", () => {
  it("starts with zero subscribers", () => {
    const bus = new LogBus();
    expect(bus.subscriberCount).toBe(0);
  });

  it("subscribe returns an unsubscribe function", () => {
    const bus = new LogBus();
    const unsubscribe = bus.subscribe(() => {});
    expect(typeof unsubscribe).toBe("function");
    expect(bus.subscriberCount).toBe(1);
  });

  it("unsubscribe removes the listener", () => {
    const bus = new LogBus();
    const unsubscribe = bus.subscribe(() => {});
    expect(bus.subscriberCount).toBe(1);
    unsubscribe();
    expect(bus.subscriberCount).toBe(0);
  });

  it("emits entries to all subscribers", () => {
    const bus = new LogBus();
    const received: LogEntry[] = [];
    const entry = createLogEntry({ message: "hello" });

    bus.subscribe((e) => received.push(e));
    bus.subscribe((e) => received.push(e));

    bus.emit(entry);

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual(entry);
    expect(received[1]).toEqual(entry);
  });

  it("does not throw when listener throws", () => {
    const bus = new LogBus();
    const entry = createLogEntry();

    bus.subscribe(() => {
      throw new Error("listener error");
    });
    bus.subscribe((_e) => {
      throw new Error("another error");
    });

    expect(() => bus.emit(entry)).not.toThrow();
  });

  it("enforces the subscriber cap", () => {
    const bus = new LogBus(2);
    const unsubscribers: Array<() => void> = [];

    unsubscribers.push(bus.subscribe(() => {}));
    unsubscribers.push(bus.subscribe(() => {}));
    expect(bus.subscriberCount).toBe(2);

    expect(() => bus.subscribe(() => {})).toThrow(
      "Log subscriber limit of 2 reached",
    );
  });

  it("allows new subscriber after unsubscribe when at cap", () => {
    const bus = new LogBus(2);
    const unsub1 = bus.subscribe(() => {});
    bus.subscribe(() => {});
    expect(bus.subscriberCount).toBe(2);

    unsub1();
    bus.subscribe(() => {});
    expect(bus.subscriberCount).toBe(2);
  });

  it("handles multiple unsubscribes gracefully", () => {
    const bus = new LogBus();
    const unsubscribe = bus.subscribe(() => {});
    expect(bus.subscriberCount).toBe(1);

    unsubscribe();
    expect(bus.subscriberCount).toBe(0);

    unsubscribe();
    expect(bus.subscriberCount).toBe(0);
  });

  it("emits to subscribers added after previous emits", () => {
    const bus = new LogBus();
    const entry1 = createLogEntry({ message: "first" });
    const entry2 = createLogEntry({ message: "second" });
    const received: string[] = [];

    bus.emit(entry1);
    bus.subscribe((e) => received.push(e.message));
    bus.emit(entry2);

    expect(received).toEqual(["second"]);
  });

  it("emits to all current subscribers even if one unsubscribes during emit", () => {
    const bus = new LogBus();
    const received: string[] = [];

    const unsub = bus.subscribe((e) => {
      received.push(e.message);
      unsub();
    });
    bus.subscribe((e) => received.push(e.message));

    bus.emit(createLogEntry({ message: "test" }));

    expect(received).toHaveLength(2);
  });
});
