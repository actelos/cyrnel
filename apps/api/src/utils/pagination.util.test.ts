import { CasingCache } from "drizzle-orm/casing";
import type { BuildQueryConfig } from "drizzle-orm/sql/sql";
import { describe, expect, it } from "vitest";
import { tools } from "@/db/schema";
import { HttpError } from "@/models/error.model";
import {
  CURSOR_VERSION,
  decodeCursor,
  encodeCursor,
  keysetConditions,
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
  paginatePage,
  paginationQuerySchema,
} from "@/utils/pagination.util";

describe("paginationQuerySchema", () => {
  it("defaults limit to 20 when absent", () => {
    expect(paginationQuerySchema.parse({}).limit).toBe(
      PAGINATION_DEFAULT_LIMIT,
    );
  });

  it("clamps limit above the maximum to 100", () => {
    expect(paginationQuerySchema.parse({ limit: "1000" }).limit).toBe(
      PAGINATION_MAX_LIMIT,
    );
  });

  it("accepts a positive integer limit", () => {
    expect(paginationQuerySchema.parse({ limit: "5" }).limit).toBe(5);
  });

  it.each(["0", "-1", "1.5", "abc"])("rejects limit=%s", (raw) => {
    expect(() => paginationQuerySchema.parse({ limit: raw })).toThrow();
  });

  it("accepts an optional cursor", () => {
    expect(paginationQuerySchema.parse({ cursor: "abc" }).cursor).toBe("abc");
  });
});

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a sort key", () => {
    const token = encodeCursor(["2026-08-01T12:00:00Z", "openapi"]);
    expect(decodeCursor(token)).toEqual({
      v: CURSOR_VERSION,
      sortKey: ["2026-08-01T12:00:00Z", "openapi"],
    });
  });

  it("rejects malformed tokens with 400 invalid_cursor", () => {
    for (const raw of [
      "nope",
      "",
      "%%%",
      Buffer.from("not json").toString("base64url"),
    ]) {
      try {
        decodeCursor(raw);
        expect.unreachable("expected invalid_cursor error");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        const http = err as HttpError;
        expect(http.statusCode).toBe(400);
        expect(http.code).toBe("invalid_cursor");
      }
    }
  });

  it("rejects tokens with a valid shape but wrong version as cursor_expired", () => {
    const token = Buffer.from(
      JSON.stringify({ v: 99, sortKey: ["a", "b"] }),
    ).toString("base64url");
    try {
      decodeCursor(token);
      expect.unreachable("expected cursor_expired error");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const http = err as HttpError;
      expect(http.statusCode).toBe(400);
      expect(http.code).toBe("cursor_expired");
    }
  });
});

describe("paginatePage", () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    id: `item-${index}`,
    rank: index,
  }));
  const keyOf = (item: { id: string; rank: number }) => [item.id];

  it("returns a full page and nextCursor when more rows exist", () => {
    const result = paginatePage(rows, 20, keyOf);
    expect(result.items).toHaveLength(20);
    expect(result.items[0].id).toBe("item-0");
    expect(result.nextCursor).toBe(encodeCursor(["item-19"]));
    expect(result.hasMore).toBe(true);
  });

  it("returns all rows and a null cursor on the last page", () => {
    const result = paginatePage(rows.slice(20), 20, keyOf);
    expect(result.items).toHaveLength(5);
    expect(result.nextCursor).toBeNull();
    expect(result.hasMore).toBe(false);
  });

  it("returns an empty page when no rows", () => {
    const result = paginatePage([], 20, keyOf);
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
    expect(result.hasMore).toBe(false);
  });
});

describe("keysetConditions", () => {
  const buildConfig: BuildQueryConfig = {
    casing: new CasingCache("snake_case"),
    escapeName: (name) => `"${name}"`,
    escapeParam: () => "?",
    escapeString: (str) => `'${str}'`,
  };
  const sqlOf = (condition: ReturnType<typeof keysetConditions>) =>
    condition?.toQuery(buildConfig).sql;

  it("returns undefined for an empty column list", () => {
    expect(keysetConditions([], "before")).toBeUndefined();
  });

  it("builds a simple comparison for a single column", () => {
    const condition = keysetConditions([[tools.serviceId, "alpha"]], "after");
    expect(sqlOf(condition)).toBe('"tools"."service_id" > ?');
  });

  it("expands a composite tuple in after mode", () => {
    const condition = keysetConditions(
      [
        [tools.serviceId, "alpha"],
        [tools.id, "tool-099"],
      ],
      "after",
    );
    expect(sqlOf(condition)).toBe(
      '("tools"."service_id" > ? or ("tools"."service_id" = ? and "tools"."id" > ?))',
    );
  });

  it("expands a composite tuple in before mode", () => {
    const condition = keysetConditions(
      [
        [tools.serviceId, "alpha"],
        [tools.id, "tool-099"],
      ],
      "before",
    );
    expect(sqlOf(condition)).toBe(
      '("tools"."service_id" < ? or ("tools"."service_id" = ? and "tools"."id" < ?))',
    );
  });

  it("accumulates equalities for triples and beyond", () => {
    const condition = keysetConditions(
      [
        [tools.serviceId, "alpha"],
        [tools.id, "tool-099"],
        [tools.name, "x"],
      ],
      "after",
    );
    expect(sqlOf(condition)).toBe(
      '("tools"."service_id" > ? or ("tools"."service_id" = ? and "tools"."id" > ?) or ("tools"."service_id" = ? and "tools"."id" = ? and "tools"."name" > ?))',
    );
  });
});
