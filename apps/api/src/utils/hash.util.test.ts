import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { computeContentHash } from "@/utils/hash.util";

describe("hash.util", () => {
  describe("computeContentHash", () => {
    it("returns the sha256 hex digest of utf8 content", () => {
      const content = "hello world";
      const expected = createHash("sha256")
        .update(content, "utf8")
        .digest("hex");

      expect(computeContentHash(content)).toBe(expected);
    });

    it("returns a 64-character lowercase hex string", () => {
      const hash = computeContentHash("anything");

      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("returns the same hash for identical inputs", () => {
      expect(computeContentHash("same")).toBe(computeContentHash("same"));
    });

    it("returns different hashes for different inputs", () => {
      expect(computeContentHash("a")).not.toBe(computeContentHash("b"));
    });

    it("handles empty strings", () => {
      const empty = createHash("sha256").update("", "utf8").digest("hex");

      expect(computeContentHash("")).toBe(empty);
    });

    it("handles multibyte unicode content", () => {
      const content = "héllo 🌍 世界";
      const expected = createHash("sha256")
        .update(content, "utf8")
        .digest("hex");

      expect(computeContentHash(content)).toBe(expected);
    });
  });
});
