import { describe, expect, it } from "vitest";

import {
  isKindCompatible,
  parseKind,
  rankAdapters,
  resolveDefaultAdapterId,
} from "@/utils/compatibility.util";

describe("parseKind", () => {
  it("splits an identifier and version", () => {
    expect(parseKind("openapi@3.0")).toEqual({
      identifier: "openapi",
      version: "3.0",
    });
  });

  it("returns undefined when no kind is given", () => {
    expect(parseKind(undefined)).toBeUndefined();
  });
});

describe("isKindCompatible", () => {
  const kind = { identifier: "openapi", version: "3.0" };

  it("accepts a matching range", () => {
    expect(
      isKindCompatible(kind, [
        { identifier: "openapi", version: ">=3.0 <4.0" },
      ]),
    ).toBe(true);
  });

  it("rejects a non-matching identifier", () => {
    expect(
      isKindCompatible(kind, [{ identifier: "asyncapi", version: ">=2.0" }]),
    ).toBe(false);
  });

  it("rejects an out-of-range version", () => {
    expect(
      isKindCompatible(kind, [
        { identifier: "openapi", version: ">=3.1 <4.0" },
      ]),
    ).toBe(false);
  });

  it("returns false when compatibility is undefined", () => {
    expect(isKindCompatible(kind, undefined)).toBe(false);
  });

  it("padds a short version before matching", () => {
    expect(
      isKindCompatible({ identifier: "openapi", version: "3" }, [
        { identifier: "openapi", version: ">=3.0.0" },
      ]),
    ).toBe(true);
  });
});

describe("rankAdapters", () => {
  const kind = { identifier: "openapi", version: "3.0" };
  const compatible = [{ identifier: "openapi", version: ">=3.0 <4.0" }];
  const adapters = [
    { id: "c", name: "C", active: true, compatibility: compatible },
    { id: "b", name: "B", active: false, compatibility: compatible },
    { id: "d", name: "D", active: true },
    { id: "a", name: "A", active: true, compatibility: compatible },
  ];

  it("ranks compatible-active first, then compatible-inactive, then the rest by name", () => {
    const ranked = rankAdapters(kind, adapters);
    expect(ranked.map((a) => a.id)).toEqual(["a", "c", "b", "d"]);
  });

  it("does not mutate the input", () => {
    const copy = [...adapters];
    rankAdapters(kind, adapters);
    expect(adapters).toEqual(copy);
  });

  it("prefers a built-in adapter among compatible-active ties", () => {
    const tied = [
      {
        id: "third",
        name: "Third",
        active: true,
        isBuiltin: false,
        compatibility: compatible,
      },
      {
        id: "core",
        name: "Core",
        active: true,
        isBuiltin: true,
        compatibility: compatible,
      },
    ];
    const ranked = rankAdapters(kind, tied);
    expect(ranked.map((a) => a.id)).toEqual(["core", "third"]);
  });

  it("ranks every compatible adapter before any incompatible one", () => {
    const mixed = [
      {
        id: "incompat-active-builtin",
        name: "IncompatActiveBuiltin",
        active: true,
        isBuiltin: true,
        compatibility: [{ identifier: "asyncapi", version: ">=2.0" }],
      },
      {
        id: "compat-inactive",
        name: "CompatInactive",
        active: false,
        compatibility: compatible,
      },
      {
        id: "compat-active",
        name: "CompatActive",
        active: true,
        compatibility: compatible,
      },
    ];
    const ranked = rankAdapters(kind, mixed);
    expect(ranked.map((a) => a.id)).toEqual([
      "compat-active",
      "compat-inactive",
      "incompat-active-builtin",
    ]);
  });
});

describe("parseKind", () => {
  it("throws on a kind without a version", () => {
    expect(() => parseKind("openapi")).toThrow();
  });

  it("throws on a malformed kind", () => {
    expect(() => parseKind("not-a-kind")).toThrow();
  });
});

describe("resolveDefaultAdapterId", () => {
  const kind = { identifier: "openapi", version: "3.0" };
  const compatible = [{ identifier: "openapi", version: ">=3.0 <4.0" }];
  const adapters = [
    { id: "a", name: "A", active: false, compatibility: compatible },
    { id: "b", name: "B", active: true, compatibility: compatible },
    { id: "c", name: "C", active: true },
  ];

  it("picks the first compatible and active adapter", () => {
    expect(resolveDefaultAdapterId(kind, adapters)).toBe("b");
  });

  it("returns undefined when nothing is compatible and active", () => {
    const incompatible = adapters.map((a) => ({
      ...a,
      active: false,
      compatibility: [{ identifier: "asyncapi", version: ">=2.0" }],
    }));
    expect(resolveDefaultAdapterId(kind, incompatible)).toBeUndefined();
  });
});
