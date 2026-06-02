import { describe, expect, it } from "vitest";
import { z } from "zod";

import { HttpError } from "@/models/error.model";
import {
  applyJsonSchemaDefaults,
  parseOrHttpError,
  validateJsonSchema,
} from "@/utils/validation.util";

describe("validation.util", () => {
  describe("parseOrHttpError", () => {
    const schema = z.object({ name: z.string().min(1, "name required") });

    it("returns parsed data when valid", () => {
      expect(parseOrHttpError(schema, { name: "ada" })).toEqual({
        name: "ada",
      });
    });

    it("throws HttpError with the first zod issue message", () => {
      expect(() => parseOrHttpError(schema, { name: "" })).toThrow(HttpError);

      try {
        parseOrHttpError(schema, { name: "" });
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(400);
        expect((err as HttpError).message).toBe("name required");
      }
    });

    it("uses the fallback message when no zod issue exists", () => {
      const alwaysFail = z.never();

      try {
        parseOrHttpError(alwaysFail, "anything", "Bad payload.");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).message.length).toBeGreaterThan(0);
      }
    });

    it("honors a custom status code", () => {
      try {
        parseOrHttpError(schema, { name: "" }, "fallback", 422);
      } catch (err) {
        expect((err as HttpError).statusCode).toBe(422);
      }
    });
  });

  describe("validateJsonSchema", () => {
    const schema = {
      type: "object",
      properties: { age: { type: "integer", minimum: 0 } },
      required: ["age"],
      additionalProperties: false,
    };

    it("passes for valid payloads", () => {
      expect(() => validateJsonSchema(schema, { age: 5 })).not.toThrow();
    });

    it("throws HttpError(400) for invalid payloads", () => {
      try {
        validateJsonSchema(schema, { age: -1 });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(400);
        expect((err as HttpError).message).toContain("/age");
      }
    });

    it("includes the custom message prefix in error output", () => {
      try {
        validateJsonSchema(schema, {}, "Bad input.");
      } catch (err) {
        expect((err as HttpError).message.startsWith("Bad input.")).toBe(true);
      }
    });

    it("caches compiled validators across calls", () => {
      expect(() => validateJsonSchema(schema, { age: 1 })).not.toThrow();
      expect(() => validateJsonSchema(schema, { age: 2 })).not.toThrow();
    });
  });

  describe("applyJsonSchemaDefaults", () => {
    const schema = {
      type: "object",
      properties: {
        retries: { type: "integer", default: 3 },
        name: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    };

    it("fills in defaults for missing properties", () => {
      const result = applyJsonSchemaDefaults(schema, { name: "x" });

      expect(result).toEqual({ name: "x", retries: 3 });
    });

    it("does not overwrite provided values", () => {
      const result = applyJsonSchemaDefaults(schema, { name: "x", retries: 9 });

      expect(result.retries).toBe(9);
    });

    it("does not mutate the original payload", () => {
      const original = { name: "x" } as Record<string, unknown>;
      const result = applyJsonSchemaDefaults(schema, original);

      expect(original).toEqual({ name: "x" });
      expect(result).not.toBe(original);
    });

    it("throws HttpError(400) when schema validation fails", () => {
      try {
        applyJsonSchemaDefaults(schema, {} as Record<string, unknown>);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(400);
      }
    });

    it("handles null/undefined payload by treating it as an empty object", () => {
      const lenient = {
        type: "object",
        properties: { flag: { type: "boolean", default: true } },
      };

      const result = applyJsonSchemaDefaults(
        lenient,
        null as unknown as Record<string, unknown>,
      );

      expect(result).toEqual({ flag: true });
    });
  });
});
