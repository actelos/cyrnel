import { describe, expect, it } from "vitest";

import {
  getUniqueConstraintColumn,
  isUniqueConstraintError,
} from "@/utils/db-errors.util";

describe("db-errors.util", () => {
  describe("isUniqueConstraintError", () => {
    it("returns true for PostgreSQL unique violation (code 23505)", () => {
      expect(isUniqueConstraintError({ code: "23505" })).toBe(true);
    });

    it("returns true for SQLite UNIQUE constraint error code", () => {
      expect(
        isUniqueConstraintError({ code: "SQLITE_CONSTRAINT_UNIQUE" }),
      ).toBe(true);
    });

    it("returns true for SQLite PRIMARYKEY constraint error code", () => {
      expect(
        isUniqueConstraintError({ code: "SQLITE_CONSTRAINT_PRIMARYKEY" }),
      ).toBe(true);
    });

    it("returns true for case-insensitive SQLite constraint codes", () => {
      expect(
        isUniqueConstraintError({ code: "sqlite_constraint_unique" }),
      ).toBe(true);
      expect(
        isUniqueConstraintError({ code: "Sqlite_Constraint_Primarykey" }),
      ).toBe(true);
    });

    it("returns true for 'UNIQUE constraint failed' message", () => {
      expect(
        isUniqueConstraintError({
          message: "UNIQUE constraint failed: users.email",
        }),
      ).toBe(true);
    });

    it("returns true for 'duplicate key value' message", () => {
      expect(
        isUniqueConstraintError({
          message: "duplicate key value violates unique constraint",
        }),
      ).toBe(true);
    });

    it("returns true for 'duplicate key' message", () => {
      expect(isUniqueConstraintError({ message: "duplicate key error" })).toBe(
        true,
      );
    });

    it("returns true for 'violates unique constraint' message", () => {
      expect(
        isUniqueConstraintError({
          message: "violates unique constraint users_pkey",
        }),
      ).toBe(true);
    });

    it("returns true for case-insensitive message matching", () => {
      expect(
        isUniqueConstraintError({ message: "unique constraint failed: test" }),
      ).toBe(true);
      expect(isUniqueConstraintError({ message: "DUPLICATE KEY VALUE" })).toBe(
        true,
      );
    });

    it("returns false for non-unique constraint errors", () => {
      expect(
        isUniqueConstraintError({
          code: "23503",
          message: "foreign key violation",
        }),
      ).toBe(false);
      expect(
        isUniqueConstraintError({ message: "not null constraint failed" }),
      ).toBe(false);
    });

    it("returns false for null or undefined", () => {
      expect(isUniqueConstraintError(null)).toBe(false);
      expect(isUniqueConstraintError(undefined)).toBe(false);
    });

    it("returns false for non-object values", () => {
      expect(isUniqueConstraintError("error")).toBe(false);
      expect(isUniqueConstraintError(123)).toBe(false);
      expect(isUniqueConstraintError(true)).toBe(false);
    });

    it("returns false for empty object", () => {
      expect(isUniqueConstraintError({})).toBe(false);
    });

    it("handles errors with cause chain", () => {
      const cause = { code: "23505" };
      const error = { cause, message: "wrapper error" };
      expect(isUniqueConstraintError(error)).toBe(true);
    });

    it("handles nested cause chains", () => {
      const inner = { code: "23505" };
      const middle = { cause: inner };
      const outer = { cause: middle };
      expect(isUniqueConstraintError(outer)).toBe(true);
    });

    it("handles cause with matching message", () => {
      const cause = { message: "UNIQUE constraint failed: users.email" };
      const error = { cause, message: "outer error" };
      expect(isUniqueConstraintError(error)).toBe(true);
    });

    it("avoids infinite loops on circular references", () => {
      const error: { cause?: unknown; message?: string } = { message: "test" };
      error.cause = error;
      expect(isUniqueConstraintError(error)).toBe(false);
    });

    it("returns false when cause chain has no unique constraint", () => {
      const cause = { code: "23503" };
      const error = { cause, message: "foreign key error" };
      expect(isUniqueConstraintError(error)).toBe(false);
    });
  });

  describe("getUniqueConstraintColumn", () => {
    it("extracts column from 'UNIQUE constraint failed: table.column' message", () => {
      expect(
        getUniqueConstraintColumn({
          message: "UNIQUE constraint failed: users.email",
        }),
      ).toBe("users.email");
    });

    it("extracts column from message with different spacing", () => {
      expect(
        getUniqueConstraintColumn({
          message: "UNIQUE constraint failed:   products.sku",
        }),
      ).toBe("products.sku");
    });

    it("returns null for non-matching messages", () => {
      expect(
        getUniqueConstraintColumn({ message: "duplicate key value" }),
      ).toBeNull();
      expect(
        getUniqueConstraintColumn({ message: "foreign key violation" }),
      ).toBeNull();
    });

    it("returns null for null or undefined", () => {
      expect(getUniqueConstraintColumn(null)).toBeNull();
      expect(getUniqueConstraintColumn(undefined)).toBeNull();
    });

    it("returns null for non-object values", () => {
      expect(getUniqueConstraintColumn("error")).toBeNull();
      expect(getUniqueConstraintColumn(123)).toBeNull();
    });

    it("returns null for empty object", () => {
      expect(getUniqueConstraintColumn({})).toBeNull();
    });

    it("handles errors with cause chain", () => {
      const cause = { message: "UNIQUE constraint failed: users.username" };
      const error = { cause, message: "wrapper error" };
      expect(getUniqueConstraintColumn(error)).toBe("users.username");
    });

    it("handles nested cause chains", () => {
      const inner = { message: "UNIQUE constraint failed: items.sku" };
      const middle = { cause: inner };
      const outer = { cause: middle };
      expect(getUniqueConstraintColumn(outer)).toBe("items.sku");
    });

    it("avoids infinite loops on circular references", () => {
      const error: { cause?: unknown; message?: string } = { message: "test" };
      error.cause = error;
      expect(getUniqueConstraintColumn(error)).toBeNull();
    });

    it("returns null when cause chain has no matching message", () => {
      const cause = { message: "some other error" };
      const error = { cause, message: "outer error" };
      expect(getUniqueConstraintColumn(error)).toBeNull();
    });

    it("is case-insensitive for the pattern", () => {
      expect(
        getUniqueConstraintColumn({
          message: "unique constraint failed: users.email",
        }),
      ).toBe("users.email");
      expect(
        getUniqueConstraintColumn({
          message: "Unique Constraint Failed: products.id",
        }),
      ).toBe("products.id");
    });
  });
});
