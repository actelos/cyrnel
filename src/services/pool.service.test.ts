import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "@/logger";
import { createPool } from "@/services/pool.service";
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
  ) {
    super();
    this.label = label;
  }

  async setup(): Promise<void> {
    if (this.setupImpl) {
      await this.setupImpl();
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

    const pool = createPool();

    await pool.initialize(
      new Map([
        ["a", moduleA],
        ["b", moduleB],
      ]),
    );

    expect(setupA).toHaveBeenCalledTimes(1);
    expect(setupB).toHaveBeenCalledTimes(1);
    expect(pool.instances).toHaveLength(2);
  });

  it("initialize() skips a module when setup() throws and logs warning", async () => {
    const badError = new Error("boom");
    const setupBad = vi.fn().mockRejectedValue(badError);
    const setupGood = vi.fn().mockResolvedValue(undefined);

    const bad = new TestEnvironmentModule("bad", setupBad);
    const good = new TestEnvironmentModule("good", setupGood);

    const pool = createPool();

    await pool.initialize(
      new Map([
        ["bad-id", bad],
        ["good-id", good],
      ]),
    );

    expect(setupBad).toHaveBeenCalledTimes(1);
    expect(setupGood).toHaveBeenCalledTimes(1);
    expect(pool.instances).toHaveLength(1);
    expect(pool.instances[0]?.module).toBe(good);
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

    const pool = createPool();

    await expect(pool.initialize(new Map([["bad-id", bad]]))).rejects.toThrow(
      "No pool instances initialized",
    );
  });

  it("initialize() rejects callers waiting in acquire() queue", async () => {
    const pool = createPool();
    const moduleA = new TestEnvironmentModule("a");
    const moduleB = new TestEnvironmentModule("b");

    pool.instances.push({ module: moduleA, busy: false });
    const inUse = await pool.acquire();
    const waitingAcquire = pool.acquire();

    expect(pool.queue).toHaveLength(1);

    await pool.initialize(new Map([["b", moduleB]]));

    await expect(waitingAcquire).rejects.toThrow("Pool was re-initialized");
    expect(pool.queue).toHaveLength(0);
    expect(pool.instances).toHaveLength(1);
    expect(pool.instances[0]?.module).toBe(moduleB);

    pool.release(inUse);
    expect(pool.instances[0]?.busy).toBe(false);
  });

  it("acquire() returns a free instance immediately and marks it busy", async () => {
    const pool = createPool();
    const moduleA = new TestEnvironmentModule("a");

    pool.instances.push({ module: moduleA, busy: false });

    const instance = await pool.acquire();

    expect(instance.module).toBe(moduleA);
    expect(instance.busy).toBe(true);
    expect(pool.queue).toHaveLength(0);
  });

  it("acquire() parks caller and resolves when release() is called", async () => {
    const pool = createPool();
    const moduleA = new TestEnvironmentModule("a");
    pool.instances.push({ module: moduleA, busy: false });

    const first = await pool.acquire();
    const secondPromise = pool.acquire();

    expect(pool.queue).toHaveLength(1);

    pool.release(first);

    const second = await secondPromise;

    expect(second).toBe(first);
    expect(second.busy).toBe(true);
    expect(pool.queue).toHaveLength(0);
  });

  it("acquire() serves queued callers in FIFO order", async () => {
    const pool = createPool();
    const moduleA = new TestEnvironmentModule("a");
    pool.instances.push({ module: moduleA, busy: false });

    const first = await pool.acquire();
    const secondPromise = pool.acquire();
    const thirdPromise = pool.acquire();

    pool.release(first);
    const second = await secondPromise;

    pool.release(second);
    const third = await thirdPromise;

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(pool.queue).toHaveLength(0);
  });

  it("release() hands instance directly to queued caller without setting busy false", async () => {
    const pool = createPool();
    const moduleA = new TestEnvironmentModule("a");
    pool.instances.push({ module: moduleA, busy: false });

    const first = await pool.acquire();
    const secondPromise = pool.acquire();

    pool.release(first);

    expect(first.busy).toBe(true);

    await secondPromise;
  });

  it("release() sets busy to false when queue is empty", async () => {
    const pool = createPool();
    const moduleA = new TestEnvironmentModule("a");
    pool.instances.push({ module: moduleA, busy: false });

    const first = await pool.acquire();
    pool.release(first);

    expect(first.busy).toBe(false);
  });
});
