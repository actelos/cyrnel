import { describe, expect, it } from "vitest";

import { instantiate, manifest } from "@/index";

describe("openapi module manifest", () => {
  it("declares an empty object configSchema", () => {
    expect(manifest.configSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
  });

  it("declares an empty object secretsSchema", () => {
    expect(manifest.secretsSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
  });

  it("instantiates an adapter that accepts the new setup context", async () => {
    const adapter = instantiate();
    await expect(
      adapter.setup({ config: {}, secrets: {} }),
    ).resolves.toBeUndefined();
    await adapter.teardown();
  });
});
