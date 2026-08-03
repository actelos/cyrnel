import { describe, expect, it } from "vitest";

import {
  collectOutdatedPaths,
  filterPayloadToSchema,
  isNullOnlySchema,
  mergeStaleKeys,
  newOutdatedPaths,
  pathExists,
} from "@/utils/schema.util";

describe("schema.util", () => {
  describe("isNullOnlySchema", () => {
    it("returns true for null and single null type arrays", () => {
      expect(isNullOnlySchema({ type: "null" })).toBe(true);
      expect(isNullOnlySchema({ type: ["null"] })).toBe(true);
    });

    it("returns false for other schemas", () => {
      expect(isNullOnlySchema({ type: "object" })).toBe(false);
      expect(isNullOnlySchema({ type: ["null", "object"] })).toBe(false);
      expect(isNullOnlySchema({})).toBe(false);
    });
  });

  describe("filterPayloadToSchema", () => {
    const strictSchema = {
      type: "object",
      properties: { port: { type: "integer" } },
      additionalProperties: false,
    };

    it("keeps declared keys and drops undeclared keys at strict levels", () => {
      const result = filterPayloadToSchema(strictSchema, {
        port: 8080,
        stale: 1,
      });
      expect(result).toEqual({ port: 8080 });
    });

    it("drops undeclared keys at permissive levels by default", () => {
      const schema = { type: "object", additionalProperties: true };
      expect(filterPayloadToSchema(schema, { x: 1 })).toEqual({});
    });

    it("keeps undeclared keys at permissive levels when keepPermitted is set", () => {
      const schema = { type: "object", additionalProperties: true };
      const result = filterPayloadToSchema(
        schema,
        { x: 1, y: { z: 2 } },
        {
          keepPermitted: true,
        },
      );
      expect(result).toEqual({ x: 1, y: { z: 2 } });
    });

    it("recurses into declared object sub-schemas", () => {
      const schema = {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: { a: { type: "string" } },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      };
      const result = filterPayloadToSchema(schema, {
        nested: { a: "x", bad: 1 },
      });
      expect(result).toEqual({ nested: { a: "x" } });
    });

    it("filters array items using the items schema", () => {
      const schema = {
        type: "object",
        properties: {
          list: {
            type: "array",
            items: {
              type: "object",
              properties: { a: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      };
      const result = filterPayloadToSchema(schema, {
        list: [{ a: "1", bad: 2 }, { a: "3" }],
      });
      expect(result).toEqual({ list: [{ a: "1" }, { a: "3" }] });
    });

    it("applies tuple item schemas per index", () => {
      const schema = {
        type: "object",
        properties: {
          list: {
            type: "array",
            items: [
              {
                type: "object",
                properties: { a: { type: "string" } },
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { b: { type: "string" } },
                additionalProperties: false,
              },
            ],
          },
        },
        additionalProperties: false,
      };
      const result = filterPayloadToSchema(schema, {
        list: [{ a: "1", s: 2 }, { b: "3", t: 4 }, { a: "5" }],
      });
      expect(result).toEqual({ list: [{ a: "1" }, { b: "3" }, {}] });
    });

    it("recurses undeclared keys with the additionalProperties schema when keepPermitted is set", () => {
      const schema = {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: { keep: { type: "string" } },
          additionalProperties: false,
        },
      };
      const result = filterPayloadToSchema(
        schema,
        { extra: { keep: "x" } },
        {
          keepPermitted: true,
        },
      );
      expect(result).toEqual({ extra: { keep: "x" } });
    });
  });

  describe("collectOutdatedPaths", () => {
    it("reports undeclared keys at strict levels", () => {
      const schema = {
        type: "object",
        properties: { port: { type: "integer" } },
        additionalProperties: false,
      };
      expect(collectOutdatedPaths(schema, { port: 8080, stale: 1 })).toEqual([
        "/stale",
      ]);
    });

    it("reports nested strict paths", () => {
      const schema = {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: { a: { type: "string" } },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      };
      expect(
        collectOutdatedPaths(schema, { nested: { a: "x", bad: 1 } }),
      ).toEqual(["/nested/bad"]);
    });

    it("does not report undeclared keys at permissive levels", () => {
      const schema = { type: "object", additionalProperties: true };
      expect(collectOutdatedPaths(schema, { x: 1, y: { z: 2 } })).toEqual([]);
    });

    it("reports outdated keys inside permissive subtrees when additionalProperties is a schema", () => {
      const schema = {
        type: "object",
        properties: {},
        additionalProperties: {
          type: "object",
          properties: { keep: { type: "string" } },
          additionalProperties: false,
        },
      };
      expect(
        collectOutdatedPaths(schema, { extra: { keep: "x", bad: 1 } }),
      ).toEqual(["/extra/bad"]);
    });

    it("reports outdated keys inside array items at per-item paths", () => {
      const schema = {
        type: "object",
        properties: {
          list: {
            type: "array",
            items: {
              type: "object",
              properties: { a: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      };
      expect(
        collectOutdatedPaths(schema, {
          list: [{ a: "1", bad: 2 }, { bad: 3 }],
        }),
      ).toEqual(["/list/items/0/bad", "/list/items/1/bad"]);
    });

    it("does not report clean arrays", () => {
      const schema = {
        type: "object",
        properties: {
          list: {
            type: "array",
            items: {
              type: "object",
              properties: { a: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      };
      expect(collectOutdatedPaths(schema, { list: [{ a: "1" }] })).toEqual([]);
    });

    it("reports keys that become outdated when a permissive schema is tightened", () => {
      const permissive = { type: "object", additionalProperties: true };
      const stored = { timeout: 30, maxRetries: 3 };
      expect(collectOutdatedPaths(permissive, stored)).toEqual([]);

      const tightened = {
        type: "object",
        properties: { timeout: { type: "number" } },
        additionalProperties: false,
      };
      expect(collectOutdatedPaths(tightened, stored)).toEqual(["/maxRetries"]);
      expect(filterPayloadToSchema(tightened, stored)).toEqual({
        timeout: 30,
      });
      expect(
        filterPayloadToSchema(tightened, stored, { keepPermitted: true }),
      ).toEqual({ timeout: 30 });
    });
  });

  describe("newOutdatedPaths", () => {
    it("returns only paths that were not present before", () => {
      const before = ["/stale", "/a"];
      const after = ["/stale", "/b", "/a"];
      expect(newOutdatedPaths(before, after)).toEqual(["/b"]);
    });

    it("returns an empty array when nothing new was added", () => {
      expect(newOutdatedPaths(["/a"], ["/a"])).toEqual([]);
    });

    it("distinguishes new disallowed keys inside array items from pre-existing ones", () => {
      const schema = {
        type: "object",
        properties: {
          list: {
            type: "array",
            items: {
              type: "object",
              properties: { a: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      };
      const before = collectOutdatedPaths(schema, {
        list: [{ a: "1", bad: 2 }],
      });
      const after = collectOutdatedPaths(schema, {
        list: [{ a: "1", bad: 2, worse: 3 }],
      });
      expect(before).toEqual(["/list/items/0/bad"]);
      expect(newOutdatedPaths(before, after)).toEqual(["/list/items/0/worse"]);
    });
  });

  describe("RFC 6901 pointer escaping", () => {
    it("escapes ~ and / in outdated paths", () => {
      const schema = {
        type: "object",
        properties: { ok: { type: "string" } },
        additionalProperties: false,
      };
      expect(
        collectOutdatedPaths(schema, {
          "a/b": { "c~d": 1 },
          "e~/f": 2,
          ok: "x",
        }),
      ).toEqual(["/a~1b", "/e~0~1f"]);
    });

    it("pathExists resolves escaped pointer segments", () => {
      const doc = { "a/b": { "c~d": 1 }, list: ["x", "y"] };
      expect(pathExists(doc, "/a~1b/c~0d")).toBe(true);
      expect(pathExists(doc, "/a~1b/missing")).toBe(false);
      expect(pathExists(doc, "/list/1")).toBe(true);
      expect(pathExists(doc, "/list/2")).toBe(false);
      expect(pathExists(doc, "/list/x")).toBe(false);
    });
  });

  describe("mergeStaleKeys", () => {
    it("reinserts view-absent raw branches at every level", () => {
      const view = { a: { x: 1 } };
      const raw = { a: { x: 1, stale: 2 }, b: 3 };
      expect(mergeStaleKeys(view, raw)).toEqual({
        a: { x: 1, stale: 2 },
        b: 3,
      });
    });

    it("keeps defaulted view keys the raw payload lacks", () => {
      expect(mergeStaleKeys({ timeout: 30 }, {})).toEqual({ timeout: 30 });
    });

    it("prefers the view when both branches exist", () => {
      expect(mergeStaleKeys({ a: 1 }, { a: 2 })).toEqual({ a: 1 });
    });

    it("prefers the view on type mismatches", () => {
      expect(mergeStaleKeys({ a: 1 }, { a: { x: 1 } })).toEqual({ a: 1 });
    });

    describe("arrays", () => {
      it("reinserts raw elements past the end of the view", () => {
        const view = [{ a: "1" }];
        const raw = [
          { a: "1", stale: 1 },
          { a: "2", stale: 2 },
        ];
        expect(mergeStaleKeys(view, raw)).toEqual([
          { a: "1", stale: 1 },
          { a: "2", stale: 2 },
        ]);
      });

      it("keeps view elements when the raw array is shorter", () => {
        const view = [{ a: "1", x: 1 }, { a: "2" }];
        const raw = [{ a: "1" }];
        expect(mergeStaleKeys(view, raw)).toEqual([
          { a: "1", x: 1 },
          { a: "2" },
        ]);
      });

      it("merges object items pairwise", () => {
        const view = [{ a: "1" }];
        const raw = [{ a: "1", stale: 1 }];
        expect(mergeStaleKeys(view, raw)).toEqual([{ a: "1", stale: 1 }]);
      });

      it("reinserts raw-only keys when object items mismatch", () => {
        const view = [{ a: "1" }];
        const raw = [{ b: "2" }];
        expect(mergeStaleKeys(view, raw)).toEqual([{ a: "1", b: "2" }]);
      });

      it("reinserts appended raw elements after tuple filtering", () => {
        const view = [{ a: "1" }, { b: "2" }];
        const raw = [{ a: "1", stale: 1 }, { b: "2", stale: 2 }, { c: "3" }];
        expect(mergeStaleKeys(view, raw)).toEqual([
          { a: "1", stale: 1 },
          { b: "2", stale: 2 },
          { c: "3" },
        ]);
      });
    });
  });

  describe("pathExists", () => {
    const doc = { a: { b: 1 }, list: [10, 20] };

    it("treats the root pointer as existing", () => {
      expect(pathExists(doc, "")).toBe(true);
    });

    it("returns true for existing paths", () => {
      expect(pathExists(doc, "/a")).toBe(true);
      expect(pathExists(doc, "/a/b")).toBe(true);
      expect(pathExists(doc, "/list/1")).toBe(true);
    });

    it("returns false for missing paths", () => {
      expect(pathExists(doc, "/a/c")).toBe(false);
      expect(pathExists(doc, "/missing")).toBe(false);
      expect(pathExists(doc, "/list/2")).toBe(false);
      expect(pathExists(doc, "/list/x")).toBe(false);
      expect(pathExists(doc, "a")).toBe(false);
    });
  });
});
