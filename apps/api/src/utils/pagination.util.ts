import { type AnyColumn, and, eq, gt, lt, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { HttpError } from "@/models/error.model";

export const PAGINATION_DEFAULT_LIMIT = 20;
export const PAGINATION_MAX_LIMIT = 100;
export const PAGINATION_CURSOR_MAX_LENGTH = 2048;

export const paginationQuerySchema = z.object({
  cursor: z
    .string({ error: "Query param 'cursor' must be a string." })
    .max(PAGINATION_CURSOR_MAX_LENGTH, {
      error: "Query param 'cursor' is too long.",
    })
    .optional(),
  limit: z.coerce
    .number({ error: "Query param 'limit' must be a positive integer." })
    .int({ error: "Query param 'limit' must be a positive integer." })
    .min(1, { error: "Query param 'limit' must be a positive integer." })
    .transform((value) => Math.min(value, PAGINATION_MAX_LIMIT))
    .default(PAGINATION_DEFAULT_LIMIT),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const CURSOR_VERSION = 1;

export function invalidCursorError(): HttpError {
  return new HttpError(
    400,
    "Cursor is malformed or expired; restart pagination from the first page.",
    "invalid_cursor",
  );
}

export interface CursorPayload {
  v: typeof CURSOR_VERSION;
  sortKey: Array<string | number>;
}

export function encodeCursor(sortKey: Array<string | number>): string {
  const payload: CursorPayload = { v: CURSOR_VERSION, sortKey };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as CursorPayload;
  if (!Array.isArray(candidate.sortKey)) return false;
  return candidate.sortKey.every(
    (entry) => typeof entry === "string" || typeof entry === "number",
  );
}

export function decodeCursor(
  raw: string,
  expectedArity?: number,
): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalidCursorError();
  }
  if (!isCursorPayload(parsed)) {
    throw invalidCursorError();
  }
  if (parsed.v !== CURSOR_VERSION) {
    throw new HttpError(
      400,
      "Cursor is from an unsupported pagination version; restart pagination from the first page.",
      "cursor_expired",
    );
  }
  if (expectedArity !== undefined && parsed.sortKey.length !== expectedArity) {
    throw invalidCursorError();
  }
  return parsed;
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function paginatePage<T>(
  rows: T[],
  limit: number,
  sortKeyOf: (item: T) => Array<string | number>,
): PaginatedResult<T> {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page,
    nextCursor:
      hasMore && page.length > 0
        ? encodeCursor(sortKeyOf(page[page.length - 1]))
        : null,
    hasMore,
  };
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function keysetConditions(
  columns: Array<[column: AnyColumn, value: string | number]>,
  mode: "before" | "after",
): SQL<unknown> | undefined {
  if (columns.length === 0) return undefined;
  const compare = mode === "after" ? gt : lt;

  const [first, ...rest] = columns;
  const parts: Array<SQL<unknown> | undefined> = [compare(first[0], first[1])];
  const equalities: SQL<unknown>[] = [eq(first[0], first[1])];
  for (const [column, value] of rest) {
    parts.push(and(...equalities, compare(column, value)));
    equalities.push(eq(column, value));
  }
  return parts.length === 1 ? parts[0] : or(...parts);
}
