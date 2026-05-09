import { describe, expect, it } from "vitest";

import { AdapterPoolService } from "@/services/adapter-pool.service";

describe("AdapterPoolService", () => {
  it("allocate() returns the same adapter instance", () => {
    const pool = new AdapterPoolService();

    const first = pool.allocate();
    const second = pool.allocate();

    expect(first).toBe(second);

    pool.release(first);
    pool.release(second);
  });

  it("release() is a no-op for unknown adapters", () => {
    const pool = new AdapterPoolService();

    const adapter = pool.allocate();
    pool.release(adapter);

    pool.release(adapter);
  });

  it("shutdown() prevents further allocation", () => {
    const pool = new AdapterPoolService();

    const adapter = pool.allocate();
    pool.release(adapter);
    pool.shutdown();

    expect(() => pool.allocate()).toThrow("Adapter pool has been shut down.");
  });
});
