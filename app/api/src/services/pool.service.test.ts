import { afterEach, describe, expect, it, vi } from "vitest";

import { EnvironmentModule } from "@/modules/environment.module";
import { EnvironmentPoolService } from "@/services/pool.service";

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred promise not initialized");
  };

  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}

async function waitForReadyStaging(
  pool: EnvironmentPoolService,
): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (pool.getStagingState().status === "ready") {
      return;
    }

    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
  }

  throw new Error("Timed out waiting for pool staging state to become ready");
}

describe("EnvironmentPoolService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("initialize() stages environment and allocate() returns staged module", async () => {
    const pool = new EnvironmentPoolService();
    const manifestService = {
      getAllStagedServiceManifests: vi.fn(async () => []),
    };

    await pool.initialize(manifestService);

    const module = pool.allocate();

    expect(module).toBeTruthy();
    pool.release(module);
  });

  it("allocate() throws when no staged environment is available", () => {
    const pool = new EnvironmentPoolService();

    expect(() => pool.allocate()).toThrow("No staged environment is available");
  });

  it("requestRestage() defers staging while environment is leased", async () => {
    const pool = new EnvironmentPoolService();
    const manifestService = {
      getAllStagedServiceManifests: vi.fn(async () => [
        {
          name: "github",
          tools: [
            {
              name: "echo",
            },
          ],
        },
      ]),
    };

    await pool.initialize(manifestService);
    const module = pool.allocate();

    pool.requestRestage();
    expect(manifestService.getAllStagedServiceManifests).toHaveBeenCalledTimes(
      1,
    );

    pool.release(module);
    await vi.waitFor(
      () => {
        expect(
          manifestService.getAllStagedServiceManifests,
        ).toHaveBeenCalledTimes(2);
      },
      {
        timeout: 1_000,
        interval: 10,
      },
    );
  });

  it("does not kill swapped module while it is still leased", async () => {
    vi.useFakeTimers();
    // Mock EnvironmentModule.prototype.execute to avoid spinning up a real worker;
    // this test focuses on lease/swap lifecycle behavior, not module execution.
    vi.spyOn(EnvironmentModule.prototype, "execute").mockResolvedValue(
      "success",
    );

    const deferredRestage = createDeferred<[] | never[]>();
    const manifestService = {
      getAllStagedServiceManifests: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockImplementationOnce(async () => deferredRestage.promise),
    };

    const pool = new EnvironmentPoolService();
    await pool.initialize(manifestService);

    const leasedModule = pool.allocate();
    const killSpy = vi.spyOn(leasedModule, "kill");
    pool.release(leasedModule);

    pool.requestRestage();
    const oldModule = pool.allocate();

    deferredRestage.resolve([]);
    await waitForReadyStaging(pool);

    expect(killSpy).toHaveBeenCalledTimes(0);

    pool.release(oldModule);
    await Promise.resolve();

    expect(killSpy).toHaveBeenCalledTimes(1);
  });

  it("schedules retries after staging failure", async () => {
    vi.useFakeTimers();
    // Mock EnvironmentModule.prototype.execute to keep the retry test deterministic
    // and avoid real environment execution side effects during staged verification.
    vi.spyOn(EnvironmentModule.prototype, "execute").mockResolvedValue(
      "success",
    );

    const pool = new EnvironmentPoolService();
    const manifestService = {
      getAllStagedServiceManifests: vi
        .fn()
        .mockRejectedValueOnce(new Error("db unavailable"))
        .mockResolvedValue([]),
    };

    await pool.initialize(manifestService);

    expect(pool.getStagingState().status).toBe("failed");
    expect(pool.hasReadyEnvironment()).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    await waitForReadyStaging(pool);

    expect(manifestService.getAllStagedServiceManifests).toHaveBeenCalledTimes(
      2,
    );
    expect(pool.getStagingState().status).toBe("ready");
    expect(pool.hasReadyEnvironment()).toBe(true);
  });

  it("shutdown() kills staged environment module", async () => {
    const pool = new EnvironmentPoolService();
    const manifestService = {
      getAllStagedServiceManifests: vi.fn(async () => []),
    };

    await pool.initialize(manifestService);
    const module = pool.allocate();
    const killSpy = vi.spyOn(module, "kill");
    pool.release(module);

    await pool.shutdown();

    expect(killSpy).toHaveBeenCalledTimes(1);
  });

  it("allocate() throws after shutdown", async () => {
    const pool = new EnvironmentPoolService();

    await pool.shutdown();

    expect(() => pool.allocate()).toThrow(
      "Environment pool has been shut down",
    );
  });
});
