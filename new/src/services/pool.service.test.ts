import { describe, expect, it, vi } from "vitest";

import { EnvironmentModule } from "@/modules/environment.module";
import { EnvironmentPoolService } from "@/services/pool.service";

describe("EnvironmentPoolService", () => {
  it("allocate() returns an EnvironmentModule instance", () => {
    const pool = new EnvironmentPoolService();

    const module = pool.allocate();

    expect(module).toBeInstanceOf(EnvironmentModule);
  });

  it("allocate() returns the same default module instance", () => {
    const pool = new EnvironmentPoolService();

    const first = pool.allocate();
    const second = pool.allocate();

    expect(first).toBe(second);
  });

  it("shutdown() kills the default environment module", async () => {
    const pool = new EnvironmentPoolService();
    const module = pool.allocate();
    const killSpy = vi.spyOn(module, "kill").mockResolvedValue();

    await pool.shutdown();

    expect(killSpy).toHaveBeenCalledTimes(1);
  });

  it("allocate() throws after shutdown", async () => {
    const pool = new EnvironmentPoolService();

    await pool.shutdown();

    expect(() => pool.allocate()).toThrow("Environment pool has been shut down");
  });
});
