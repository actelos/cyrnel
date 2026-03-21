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

const waitForQueueLength = async (
  pool: ReturnType<typeof createEnvironmentPool>,
  expectedLength: number,
  attempts = 20,
): Promise<void> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (pool.getQueue().length === expectedLength) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  throw new Error(
    `Timed out waiting for queue length ${expectedLength} (current: ${pool.getQueue().length})`,
  );
};

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

  it("initialize() defers setup() until acquire()", async () => {
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

    expect(setupA).not.toHaveBeenCalled();
    expect(setupB).not.toHaveBeenCalled();
    expect(pool.getInstances()).toHaveLength(0);

    const first = await pool.acquire("a");
    const second = await pool.acquire("b");

    expect(setupA).toHaveBeenCalledTimes(1);
    expect(setupB).toHaveBeenCalledTimes(1);
    expect(pool.getInstances()).toHaveLength(2);
    expect(first.module).toBe(moduleA);
    expect(second.module).toBe(moduleB);
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
    const instanceA = await pool.acquire("a");
    const instanceB = await pool.acquire("b");
    pool.release(instanceA);
    pool.release(instanceB);
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
    const instanceA = await pool.acquire("a");
    const instanceB = await pool.acquire("b");
    pool.release(instanceA);
    pool.release(instanceB);

    await pool.shutdown();

    expect(teardownSpyA).toHaveBeenCalledTimes(1);
    expect(teardownSpyB).toHaveBeenCalledTimes(1);
  });

  it("shutdown() rejects queued acquire() calls", async () => {
    const pool = createEnvironmentPool();
    const moduleA = new TestEnvironmentModule("a");

    await pool.initialize(new Map([["a", moduleA]]));

    const inUse = await pool.acquire("a");
    const waitingAcquire = pool.acquire("a");

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
    const instance = await pool.acquire("a");
    pool.release(instance);

    await expect(pool.shutdown()).resolves.toBeUndefined();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { err: teardownError, moduleLabel: "a" },
      "Failed to teardown module instance",
    );
  });

  it("acquire() skips a module when setup() throws and logs warning", async () => {
    const badError = new Error("boom");
    const setupBad = vi.fn().mockRejectedValue(badError);
    const setupGood = vi.fn().mockResolvedValue(undefined);

    const bad = new TestEnvironmentModule("bad|good", setupBad);
    const good = new TestEnvironmentModule("good", setupGood);

    const pool = createEnvironmentPool();

    await pool.initialize(
      new Map([
        ["bad-id", bad],
        ["good-id", good],
      ]),
    );

    const instance = await pool.acquire("good");

    expect(setupBad).toHaveBeenCalledTimes(1);
    expect(setupGood).toHaveBeenCalledTimes(1);
    expect(pool.getInstances()).toHaveLength(1);
    expect(pool.getInstances()[0]?.module).toBe(good);
    expect(instance.module).toBe(good);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      {
        err: badError,
        moduleId: "bad-id",
        moduleLabel: "bad|good",
      },
      "Failed to setup module instance; skipping",
    );
  });

  it("acquire() throws when zero modules initialize successfully", async () => {
    const setupBad = vi.fn().mockRejectedValue(new Error("boom"));
    const bad = new TestEnvironmentModule("bad", setupBad);

    const pool = createEnvironmentPool();

    await pool.initialize(new Map([["bad-id", bad]]));

    await expect(pool.acquire("bad")).rejects.toThrow(
      "No pool instances initialized",
    );
  });

  it("initialize() rejects callers waiting in acquire() queue", async () => {
    const pool = createEnvironmentPool();
    const moduleA = new TestEnvironmentModule("a");
    const moduleB = new TestEnvironmentModule("b");

    await pool.initialize(new Map([["a", moduleA]]));
    const inUse = await pool.acquire("a");
    const waitingAcquire = pool.acquire("a");

    await waitForQueueLength(pool, 1);
    expect(pool.getQueue()).toHaveLength(1);

    await expect(pool.initialize(new Map([["b", moduleB]]))).rejects.toThrow(
      "Pool has active instances",
    );

    pool.release(inUse);
    await waitingAcquire;
  });

  it("acquire() returns a free instance immediately and marks it busy", async () => {
    const pool = createEnvironmentPool();
    const moduleA = new TestEnvironmentModule("a");

    await pool.initialize(new Map([["a", moduleA]]));

    const first = await pool.acquire("a");
    pool.release(first);

    const instance = await pool.acquire("a");

    expect(instance.module).toBe(moduleA);
    expect(instance.busy).toBe(true);
    expect(pool.getQueue()).toHaveLength(0);
  });

  it("acquire() parks caller and resolves when release() is called", async () => {
    const pool = createEnvironmentPool();
    const moduleA = new TestEnvironmentModule("a");
    await pool.initialize(new Map([["a", moduleA]]));

    const first = await pool.acquire("a");
    const secondPromise = pool.acquire("a");

    await waitForQueueLength(pool, 1);
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

    const first = await pool.acquire("a");
    const secondPromise = pool.acquire("a");
    const thirdPromise = pool.acquire("a");

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
    const moduleA = new TestEnvironmentModule("node");
    const moduleB = new TestEnvironmentModule("node");
    await pool.initialize(
      new Map([
        ["a", moduleA],
        ["b", moduleB],
      ]),
    );

    const firstBusy = await pool.acquire("node");
    const secondBusy = await pool.acquire("node");
    pool.release(firstBusy);
    pool.release(secondBusy);

    const first = await pool.acquire("node");
    const second = await pool.acquire("node");

    expect(first.module).toBe(moduleA);
    expect(second.module).toBe(moduleB);
    expect(first.busy).toBe(true);
    expect(second.busy).toBe(true);
  });

  it("acquire() picks first available instance when another is busy", async () => {
    const pool = createEnvironmentPool();
    const moduleA = new TestEnvironmentModule("node");
    const moduleB = new TestEnvironmentModule("node");
    await pool.initialize(
      new Map([
        ["a", moduleA],
        ["b", moduleB],
      ]),
    );

    const instanceA = await pool.acquire("node");
    const instanceB = await pool.acquire("node");
    pool.release(instanceB);

    const acquired = await pool.acquire("node");

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

      const first = await pool.acquire("a");
      const waitingAcquire = pool.acquire("a");

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

    const first = await pool.acquire("a");
    const secondPromise = pool.acquire("a");

    await waitForQueueLength(pool, 1);
    pool.release(first);

    expect(first.busy).toBe(true);

    await secondPromise;
  });

  it("release() sets busy to false when queue is empty", async () => {
    const pool = createEnvironmentPool();
    const moduleA = new TestEnvironmentModule("a");
    await pool.initialize(new Map([["a", moduleA]]));

    const first = await pool.acquire("a");
    pool.release(first);

    expect(first.busy).toBe(false);
  });

  it("release() warns and keeps state unchanged when releasing an already non-busy instance", async () => {
    const pool = createEnvironmentPool();
    const moduleA = new TestEnvironmentModule("a");

    await pool.initialize(new Map([["a", moduleA]]));

    const instance = await pool.acquire("a");
    pool.release(instance);
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
    const foreign = { module: moduleA, matcher: /a/, busy: true };

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

    await expect(pool.acquire("a")).rejects.toThrow("Pool has been shut down");
  });
});
