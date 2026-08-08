import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CYRNEL_CORE_VERSION } from "@/constants";

const sdkPkg = JSON.parse(
  readFileSync(
    new URL("../../../packages/libs/sdk/package.json", import.meta.url),
    "utf8",
  ),
) as { version: string };

describe("CYRNEL_CORE_VERSION", () => {
  it("tracks the bundled @cyrnel/sdk version", () => {
    expect(CYRNEL_CORE_VERSION).toBe(sdkPkg.version);
  });

  it("is a valid semver string", () => {
    expect(CYRNEL_CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
