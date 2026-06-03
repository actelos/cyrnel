import { describe, expect, it } from "vitest";

import { instantiate, manifest } from "@/index";

describe("openapi module manifest", () => {
  it("declares the supported configSchema", () => {
    expect(manifest.configSchema).toMatchObject({
      type: "object",
      properties: { baseUrl: { type: "string" } },
      additionalProperties: false,
    });
  });

  it("declares the supported secretsSchema", () => {
    expect(manifest.secretsSchema).toMatchObject({
      type: "object",
      properties: { apiKey: { type: "string" } },
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
