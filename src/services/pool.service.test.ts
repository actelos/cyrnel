import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "@/logger";
import { createEnvironmentPool } from "@/services/pool.service";
import type { ExecutionStatus, EnvironmentModule } from "@/config/modules";

vi.mock("@/logger", () => ({
  logger: {
    warn: vi.fn(),
  },
}));

class TestEnvironmentModule extends EventEmitter implements EnvironmentModule {
  readonly type = "environment";
  readonly label: string;

  constructor(
    label: string,
    private readonly setupImpl?: () => Promise<void>,
    private readonly teardownImpl?: () => Promise<void>,
  ) {
    super();
    this.label = label;
  }

  async setup(): Promise<void> {
    if (this.setupImpl) {
      await this.setupImpl();
    }
  }

  async teardown(): Promise<void> {
    if (this.teardownImpl) {
      await this.teardownImpl();
    }
  }

  async execute(_code: string): Promise<ExecutionStatus> {
    return "success";
  }

  async kill(): Promise<void> {}
}

describe("pool.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initialize() calls setup() on every module", async () => {
    const setupA = vi.fn().mockResolvedValue(undefined);
    const setupB = vi.fn().mockResolvedValue(undefined);

    const moduleA = new TestEnvironmentModule("a", setupA);
    const moduleB = new TestEnvironmentModule("b", setupB);

    const pool = createEnvironmentPool();

    await pool.initialize(
      new Map([
        ["a", moduleA],
        ["b", moduleB],
      ]),
    );

    expect(setupA).toHaveBeenCalledTimes(1);
    expect(setupB).toHaveBeenCalledTimes(1);
    expect(pool.getInstances()).toHaveLength(2);
  });

  it("TestEnvironmentModule.teardown() calls teardownImpl when provided", async () => {
    const teardownA = vi.fn().mockResolvedValue(undefined);
    const teardownB = vi.fn().mockResolvedValue(undefined);

    const pool = createEnvironmentPool();
    const moduleA = new TestEnvironmentModule("a", undefined, teardownA);
    const moduleB = new TestEnvironmentModule("b", undefined, teardownB);

    await pool.initialize(
      new Map([
        ["a", moduleA],
        ["b", moduleB],
      ]),
    );
    await pool.shutdown();

    expect(teardownA).toHaveBeenCalledTimes(1);
    expect(teardownB).toHaveBeenCalledTimes(1);
    expect(pool.getInstances()).toHaveLength(0);
  });

  it("shutdown() calls teardown() on every module instance", async () => {
    const pool = createEnvironmentPool();
    const moduleA = new TestEnvironmentModule("a");
    const moduleB = new TestEnvironmentModule("b");
    const teardownSpyA = vi.spyOn(moduleA, "teardown");
    const teardownSpyB = vi.spyOn(moduleB, "teardown");

    await pool.initialize(
      new Map([
        ["a", moduleA],
        ["b", moduleB],
      ]),
    );

    await pool.shutdown();

    expect(teardownSpyA).toHaveBeenCalledTimes(1);
    expect(teardownSpyB).toHaveBeenCalledTimes(1);
  });

  it("shutdown() rejects queued acquire() calls", async () => {
    const pool = createEnvironmentPool();
    const moduleA = new TestEnvironmentModule("a");

    await pool.initialize(new Map([["a", moduleA]]));

    const inUse = await pool.acquire();
    const waitingAcquire = pool.acquire();

    const shutdownPromise = pool.shutdown();

    await expect(waitingAcquire).rejects.toThrow("Pool has been shut down");

    pool.release(inUse);
    await shutdownPromise;
  });

  it("shutdown() resolves even when teardown throws and logs warning", async () => {
    const teardownError = new Error("teardown failed");
    const teardownImpl = vi.fn().mockRejectedValue(teardownError);
    const moduleA = new TestEnvironmentModule("a", undefined, teardownImpl);
    const pool = createEnvironmentPool();

    await pool.initialize(new Map([["a", moduleA]]));

    await expect(pool.shutdown()).resolves.toBeUndefined();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { err: teardownError, moduleLabel: "a" },
      "Failed to teardown module instance",
    );
  });

  it("initialize() skips a module when setup() throws and logs warning", async () => {
    const badError = new Error("boom");
    const setupBad = vi.fn().mockRejectedValue(badError);
    const setupGood = vi.fn().mockResolvedValue(undefined);

    const bad = new TestEnvironmentModule("bad", setupBad);
    const good = new TestEnvironmentModule("good", setupGood);

    const pool = createEnvironmentPool();

    await pool.initialize(
      new Map([
        ["bad-id", bad],
        ["good-id", good],
      ]),
    );

    expect(setupBad).toHaveBeenCalledTimes(1);
    expect(setupGood).toHaveBeenCalledTimes(1);
    expect(pool.getInstances()).toHaveLength(1);
    expect(pool.getInstances()[0]?.module).toBe(good);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      {
        err: badError,
        moduleId: "bad-id",
        moduleLabel: "bad",
      },
      "Failed to setup module instance; skipping",
    );
  });

  it("initialize() throws when zero modules initialize successfully", async () => {
    const setupBad = vi.fn().mockRejectedValue(new Error("boom"));
    const bad = new TestEnvironmentModule("bad", setupBad);

    const pool = createEnvironmentPool();

    await expect(pool.initialize(new Map([["bad-id", bad]]))).rejects.toThrow(
      "No pool instances initialized",
    );
  });

  it("initialize() rejects callers waiting in acquire() queue", async () => {
    const pool = createEnvironmentPool();
    const moduleA = new TestEnvironmentModule("a");
    const moduleB = new TestEnvironmentModule("b");

    await pool.initialize(new Map([["a", moduleA]]));
    const inUse = await pool.acquire();
    const waitingAcquire = pool.acquire();

    expect(pool.getQueue()).toHaveLength(1);

    await pool.initialize(new Map([["b", moduleB]]));

    await expect(waitingAcquire).rejects.toThrow("Pool was re-initialized");
    expect(pool.getQueue()).toHaveLength(0);
    expect(pool.getInstances()).toHaveLength(1);
    expect(pool.getInstances()[0]?.module).toBe(moduleB);

    pool.release(inUse);
    expect(pool.getInstances()[0]?.busy).toBe(false);
  });

  it("acquire() returns a free instance immediately and marks it busy", async () => {
    const pool = createEnvironmentPool();
    const moduleA = new TestEnvironmentModule("a");

    await pool.initialize(new Map([["a", moduleA]]));

    const instance = await pool.acquire();

    expect(instance.module).toBe(moduleA);
    expect(instance.busy).toBe(true);
    expect(pool.getQueue()).toHaveLength(0);
  });

  it("acquire() parks caller and resolves when release() is called", async () => {
    const pool = createEnvironmentPool();
    const moduleA = new TestEnvironmentModule("a");
    await pool.initialize(new Map([["a", moduleA]]));

    const first = await pool.acquire();
    const secondPromise = pool.acquire();

    expect(pool.getQueue()).toHaveLength(1);

    pool.release(first);

    const second = await secondPromise;

    expect(second).toBe(first);
    expect(second.busy).toBe(true);
    expect(pool.getQueue()).toHaveLength(0);
  });

  it("acquire() serves queued callers in FIFO order", async () => {
    const pool = createEnvironmentPool();
    const moduleA = new TestEnvironmentModule("a");
    await pool.initialize(new Map([["a", moduleA]]));

    const first = await pool.acquire();
    const secondPromise = pool.acquire();
    const thirdPromise = pool.acquire();

    pool.release(first);
    const second = await secondPromise;

    pool.release(second);
    const third = await thirdPromise;

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(pool.getQueue()).toHaveLength(0);
  });

  it("acquire() returns multiple free instances in insertion order", async () => {
    const pool = createEnvironmentPool();
    const moduleA = new TestEnvironmentModule("a");
    const moduleB = new TestEnvironmentModule("b");
    await pool.initialize(
      new Map([
        ["a", moduleA],
        ["b", moduleB],
      ]),
    );

    const [instanceA, instanceB] = pool.getInstances();

    const first = await pool.acquire();
    const second = await pool.acquire();

    expect(first).toBe(instanceA);
    expect(second).toBe(instanceB);
    expect(first.busy).toBe(true);
    expect(second.busy).toBe(true);
  });

  it("acquire() picks first available instance when another is busy", async () => {
    const pool = createEnvironmentPool();
    const moduleA = new TestEnvironmentModule("a");
    const moduleB = new TestEnvironmentModule("b");
    await pool.initialize(
      new Map([
        ["a", moduleA],
        ["b", moduleB],
      ]),
    );

    const instanceA = await pool.acquire();
    const instanceB = pool
      .getInstances()
      .find((instance) => instance.module === moduleB);

    expect(instanceB).toBeDefined();
    if (!instanceB) {
      throw new Error("Expected moduleB instance to exist in pool");
    }

    const acquired = await pool.acquire();

    expect(acquired).toBe(instanceB);
    expect(instanceA.busy).toBe(true);
    expect(instanceB.busy).toBe(true);
  });

  it("acquire() waits while all instances are busy and resolves after release()", async () => {
    vi.useFakeTimers();

    try {
      const pool = createEnvironmentPool();
      const moduleA = new TestEnvironmentModule("a");
      await pool.initialize(new Map([["a", moduleA]]));

      const first = await pool.acquire();
      const waitingAcquire = pool.acquire();

      let resolved = false;
      waitingAcquire.then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();

      expect(resolved).toBe(false);

      pool.release(first);
      await waitingAcquire;

      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("release() hands instance directly to queued caller without setting busy false", async () => {
    const pool = createEnvironmentPool();
    const moduleA = new TestEnvironmentModule("a");
    await pool.initialize(new Map([["a", moduleA]]));

    const first = await pool.acquire();
    const secondPromise = pool.acquire();

    pool.release(first);

    expect(first.busy).toBe(true);

    await secondPromise;
  });

  it("release() sets busy to false when queue is empty", async () => {
    const pool = createEnvironmentPool();
    const moduleA = new TestEnvironmentModule("a");
    await pool.initialize(new Map([["a", moduleA]]));

    const first = await pool.acquire();
    pool.release(first);

    expect(first.busy).toBe(false);
  });

  it("release() warns and keeps state unchanged when releasing an already non-busy instance", async () => {
    const pool = createEnvironmentPool();
    const moduleA = new TestEnvironmentModule("a");

    await pool.initialize(new Map([["a", moduleA]]));

    const idleInstance = pool.getInstances()[0];

    expect(idleInstance).toBeDefined();

    pool.release(idleInstance!);

    expect(idleInstance?.busy).toBe(false);
    expect(pool.getQueue()).toHaveLength(0);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { module: "a" },
      "Attempted to release non-busy instance",
    );
  });

  it("release() ignores instances that do not belong to the pool", () => {
    const pool = createEnvironmentPool();
    const moduleA = new TestEnvironmentModule("a");
    const foreign = { module: moduleA, busy: true };

    pool.release(foreign);

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { module: "a" },
      "Attempted to release unknown instance",
    );
    expect(pool.getQueue()).toHaveLength(0);
  });

  it("acquire() rejects after shutdown", async () => {
    const pool = createEnvironmentPool();
    const moduleA = new TestEnvironmentModule("a");
    await pool.initialize(new Map([["a", moduleA]]));

    await pool.shutdown();

    await expect(pool.acquire()).rejects.toThrow("Pool has been shut down");
  });
});
