import { and, desc, eq, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { type RegistryRecord, registries } from "@/db/schema";
import { logger } from "@/infra/logging";
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
import {
  fetchRegistryCapabilityPage,
  fetchRegistryIndex,
  type RegistryPage,
} from "@/utils/registry.util";

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

  async addRegistry(baseUrl: string, id?: string): Promise<RegistryRecord> {
    const index = await fetchRegistryIndex(baseUrl);

    if (!index.definitions && !index.modules) {
      throw new HttpError(
        400,
        `Registry at '${baseUrl}' does not advertise a supported 'definitions' or 'modules' capability.`,
      );
    }

    const resolvedId = id?.trim() || index.id;

    return this.createRegistry({ id: resolvedId, baseUrl });
  }

  async refreshRegistry(id: string): Promise<RegistryRecord> {
    const existing = await this.getRegistry(id);

    const index = await fetchRegistryIndex(existing.baseUrl);

    if (!index.definitions && !index.modules) {
      throw new HttpError(
        502,
        `Registry '${id}' no longer advertises a supported capability.`,
      );
    }

    const now = new Date().toISOString();
    const [row] = await db
      .update(registries)
      .set({ lastSyncedAt: now, updatedAt: now })
      .where(eq(registries.id, id))
      .returning()
      .catch(() => {
        throw new HttpError(500, `Failed to refresh registry '${id}'.`);
      });

    return row;
  }

  async browseDefinitions(
    id: string,
    params: {
      query?: string;
      kind?: string;
      cursor?: string;
      limit?: number;
    },
  ): Promise<RegistryPage> {
    const registry = await this.getRegistry(id);
    const index = await fetchRegistryIndex(registry.baseUrl);

    if (!index.definitions) {
      throw new HttpError(
        404,
        `Registry '${id}' does not support definitions.`,
      );
    }

    return fetchRegistryCapabilityPage(
      index.definitions.url,
      "definitions",
      params,
    );
  }

  async browseModules(
    id: string,
    params: {
      query?: string;
      type?: "adapter" | "environment";
      cursor?: string;
      limit?: number;
    },
  ): Promise<RegistryPage> {
    const registry = await this.getRegistry(id);
    const index = await fetchRegistryIndex(registry.baseUrl);

    if (!index.modules) {
      throw new HttpError(404, `Registry '${id}' does not support modules.`);
    }

    return fetchRegistryCapabilityPage(index.modules.url, "modules", params);
  }

  async seedDefault(): Promise<void> {
    const seedUrl = process.env.CYRNEL_DEFAULT_REGISTRY_URL?.trim();
    if (!seedUrl) return;

    try {
      const existing = await this.listRegistries();
      if (existing.items.length > 0) return;

      await this.addRegistry(seedUrl);
    } catch (err) {
      logger.warn({ err, seedUrl }, "Failed to seed default registry");
    }
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
