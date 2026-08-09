import { and, desc, eq, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { type RegistryRecord, registries } from "@/db/schema";
import { HttpError } from "@/models/error.model";
import {
  getUniqueConstraintColumn,
  isUniqueConstraintError,
} from "@/utils/db-errors.util";
import {
  decodeCursor,
  invalidCursorError,
  keysetConditions,
  PAGINATION_DEFAULT_LIMIT,
  type PaginatedResult,
  paginatePage,
} from "@/utils/pagination.util";

const REGISTRY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface CreateRegistryInput {
  id: string;
  baseUrl: string;
}

export interface ListRegistriesInput {
  limit?: number;
  cursor?: string;
}

export class RegistriesService {
  async createRegistry(input: CreateRegistryInput): Promise<RegistryRecord> {
    const id = input.id.trim();
    if (!REGISTRY_ID_PATTERN.test(id)) {
      throw new HttpError(
        400,
        `Registry id '${id}' must be a slug matching /^[A-Za-z0-9_-]+$/.`,
      );
    }

    const baseUrl = input.baseUrl.trim();
    const normalizedBaseUrl = parseNormalizedHttpUrl(baseUrl);
    if (!normalizedBaseUrl) {
      throw new HttpError(
        400,
        `Registry base URL '${baseUrl}' must be a valid absolute http(s) URL.`,
      );
    }

    const now = new Date().toISOString();
    try {
      const [row] = await db
        .insert(registries)
        .values({
          id,
          baseUrl: normalizedBaseUrl,
          lastSyncedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return row;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        if (getUniqueConstraintColumn(error)?.endsWith(".base_url")) {
          throw new HttpError(
            409,
            `A registry with base URL '${normalizedBaseUrl}' is already registered.`,
          );
        }
        throw new HttpError(409, `Registry '${id}' already exists.`);
      }
      throw new HttpError(500, `Failed to create registry '${id}'.`);
    }
  }

  async listRegistries(
    input?: ListRegistriesInput,
  ): Promise<PaginatedResult<RegistryRecord>> {
    const limit = input?.limit ?? PAGINATION_DEFAULT_LIMIT;

    const conditions: Array<SQL | undefined> = [];
    if (input?.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor, 2);
      const [createdAt, id] = cursor.sortKey;
      if (typeof createdAt !== "string" || typeof id !== "string") {
        throw invalidCursorError();
      }
      conditions.push(
        keysetConditions(
          [
            [registries.createdAt, createdAt],
            [registries.id, id],
          ],
          "before",
        ),
      );
    }

    const rows = await db
      .select()
      .from(registries)
      .where(and(...conditions))
      .orderBy(desc(registries.createdAt), desc(registries.id))
      .limit(limit + 1)
      .catch(() => {
        throw new HttpError(500, "Failed to list registries.");
      });

    return paginatePage(rows, limit, (item) => [item.createdAt, item.id]);
  }

  async getRegistry(id: string): Promise<RegistryRecord> {
    const [row] = await db
      .select()
      .from(registries)
      .where(eq(registries.id, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, `Failed to load registry '${id}'.`);
      });

    if (!row) throw new HttpError(404, `Registry '${id}' not found.`);
    return row;
  }

  async deleteRegistry(id: string): Promise<void> {
    const [deleted] = await db
      .delete(registries)
      .where(eq(registries.id, id))
      .returning({ id: registries.id })
      .catch(() => {
        throw new HttpError(500, `Failed to delete registry '${id}'.`);
      });

    if (!deleted) throw new HttpError(404, `Registry '${id}' not found.`);
  }
}

function parseNormalizedHttpUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString();
}
