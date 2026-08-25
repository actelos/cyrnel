import { type AnyColumn, and, eq, gt, lt, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { HttpError } from "@/models/error.model";

export const PAGINATION_DEFAULT_LIMIT = 20;
export const PAGINATION_MAX_LIMIT = 100;
export const PAGINATION_CURSOR_MAX_LENGTH = 2048;

/**
 * Shared query schema for all paginated list endpoints. `cursor` is an
 * opaque token returned by a previous response; `limit` is clamped
 * server-side and never trusted unbounded.
 */
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

/**
 * Standard 400 for cursors whose shape or content does not line up with the
 * endpoint that received them (wrong key types, wrong arity, etc.). Callers
 * throw this after `decodeCursor` once they know the expected key layout.
 */
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

/**
 * Serializes a sort-key snapshot into an opaque cursor token. Clients never
 * construct cursors themselves; they only echo back what the server issued.
 */
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

/**
 * Decodes an opaque cursor token. Malformed tokens, unsupported versions,
 * and - when `expectedArity` is given - payloads whose sort-key length
 * does not match are hard errors (`400 invalid_cursor` / `400
 * cursor_expired`) rather than a silent reset to the first page.
 */
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

/**
 * Trims a `limit + 1` row fetch down to `limit` items and derives the
 * `nextCursor`/`hasMore` pair. The extra row is the standard trick for
 * detecting a next page without a separate COUNT(*) query.
 */
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

/**
 * Escapes LIKE metacharacters (`%`, `_`, and the escape character itself)
 * so a user query matches literally. Paired with `ESCAPE '\'` in the SQL.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Builds the keyset comparison predicate for an ordered tuple of sort keys:
 * `(c1, c2) < (v1, v2)` in `before` mode, `(c1, c2) > (v1, v2)` in `after`
 * mode, expanded as `c1 [<>] v1 OR (c1 = v1 AND c2 [<>] v2)`. Keeps paging
 * correct under concurrent inserts/deletes.
 */
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
