import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CYRNEL_CORE_VERSION } from "@/constants";

const sdkPkg = JSON.parse(
  readFileSync(
    new URL("../../../packages/libs/sdk/package.json", import.meta.url),
    "utf8",
  ),
) as unknown;

function sdkVersionOf(pkg: unknown): string | undefined {
  if (typeof pkg !== "object" || pkg === null || !("version" in pkg)) {
    return undefined;
  }
  const { version } = pkg as { version: unknown };
  return typeof version === "string" ? version : undefined;
}

describe("CYRNEL_CORE_VERSION", () => {
  it("tracks the bundled @cyrnel/sdk version", () => {
    const version = sdkVersionOf(sdkPkg);
    expect(version).toBeDefined();
    expect(CYRNEL_CORE_VERSION).toBe(version);
  });

  it("is a stable major.minor.patch version", () => {
    expect(CYRNEL_CORE_VERSION).toMatch(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
    );
  });
});
