import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdapterModule } from "@/modules/adapter.module";

describe("AdapterModule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invoke() returns hello world", async () => {
    const adapter = new AdapterModule();

    await expect(
      adapter.invoke("service-1", "tool-1", { input: "anything" }),
    ).resolves.toBe("hello world");
  });
});
