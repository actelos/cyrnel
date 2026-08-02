import { describe, expect, it } from "vitest";

import { MODULE_TYPES, moduleManifestSchema } from "@/models/modules.model";

const VALID_MANIFEST = {
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
    const result = moduleManifestSchema.safeParse(VALID_MANIFEST);

    expect(result.success).toBe(true);
  });

  it("accepts an environment manifest with engines", () => {
    const result = moduleManifestSchema.safeParse({
      ...VALID_MANIFEST,
      type: "environment",
      engines: { cyrnel: "^3.0.0" },
    });

    expect(result.success).toBe(true);
  });

  it("rejects an id with invalid characters", () => {
    const result = moduleManifestSchema.safeParse({
      ...VALID_MANIFEST,
      id: "1invalid-id",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an id with spaces", () => {
    const result = moduleManifestSchema.safeParse({
      ...VALID_MANIFEST,
      id: "my adapter",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an invalid semver version", () => {
    const result = moduleManifestSchema.safeParse({
      ...VALID_MANIFEST,
      version: "not-a-version",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an unknown module type", () => {
    const result = moduleManifestSchema.safeParse({
      ...VALID_MANIFEST,
      type: "plugin",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a missing main field", () => {
    const { main: _main, ...withoutMain } = VALID_MANIFEST;
    const result = moduleManifestSchema.safeParse(withoutMain);

    expect(result.success).toBe(false);
  });

  it("rejects an empty name", () => {
    const result = moduleManifestSchema.safeParse({
      ...VALID_MANIFEST,
      name: "",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a missing description", () => {
    const { description: _description, ...withoutDescription } = VALID_MANIFEST;
    const result = moduleManifestSchema.safeParse(withoutDescription);

    expect(result.success).toBe(false);
  });
});
