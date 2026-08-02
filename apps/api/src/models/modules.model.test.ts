import { describe, expect, it } from "vitest";

import { MODULE_TYPES, moduleManifestSchema } from "@/models/modules.model";

const validManifest = {
  id: "my-adapter",
  name: "My Adapter",
  version: "1.2.3",
  description: "A test adapter",
  type: "adapter",
  main: "./index.js",
} as const;

describe("MODULE_TYPES", () => {
  it("contains adapter and environment", () => {
    expect(MODULE_TYPES).toEqual(["adapter", "environment"]);
  });
});

describe("moduleManifestSchema", () => {
  it("accepts a valid adapter manifest", () => {
    const result = moduleManifestSchema.safeParse(validManifest);

    expect(result.success).toBe(true);
  });

  it("accepts an environment manifest with engines", () => {
    const result = moduleManifestSchema.safeParse({
      ...validManifest,
      type: "environment",
      engines: { cyrnel: "^3.0.0" },
    });

    expect(result.success).toBe(true);
  });

  it("rejects an id with invalid characters", () => {
    const result = moduleManifestSchema.safeParse({
      ...validManifest,
      id: "1invalid-id",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an id with spaces", () => {
    const result = moduleManifestSchema.safeParse({
      ...validManifest,
      id: "my adapter",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an invalid semver version", () => {
    const result = moduleManifestSchema.safeParse({
      ...validManifest,
      version: "not-a-version",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an unknown module type", () => {
    const result = moduleManifestSchema.safeParse({
      ...validManifest,
      type: "plugin",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a missing main field", () => {
    const { main: _main, ...withoutMain } = validManifest;
    const result = moduleManifestSchema.safeParse(withoutMain);

    expect(result.success).toBe(false);
  });

  it("rejects an empty name", () => {
    const result = moduleManifestSchema.safeParse({
      ...validManifest,
      name: "",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a missing description", () => {
    const { description: _description, ...withoutDescription } = validManifest;
    const result = moduleManifestSchema.safeParse(withoutDescription);

    expect(result.success).toBe(false);
  });
});
