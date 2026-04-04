import { describe, expect, it } from "vitest";

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
});
