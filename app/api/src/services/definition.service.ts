import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { definitions } from "@/db/schema";
import {
  DEFINITION_TYPES,
  type DefinitionResponse,
  type DefinitionType,
} from "@/models/definition.model";
import { HttpError } from "@/models/error.model";
import { computeContentHash } from "@/utils/hash.util";

type DefinitionSortField = "type";

interface DefinitionServiceOptions {
  fetchImpl?: typeof fetch;
}

interface ListDefinitionsOptions {
  sortBy?: DefinitionSortField;
  definitionId?: string;
  query?: string;
}

export class DefinitionService {
  private readonly fetchImpl: typeof fetch;

  constructor(options: DefinitionServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listDefinitions(
    options: ListDefinitionsOptions = {},
  ): Promise<DefinitionResponse[]> {
    const { sortBy, definitionId, query } = options;
    const normalizedDefinitionId = definitionId?.trim();
    const normalizedQuery = normalizeOptionalQuery(query);

    if (definitionId !== undefined && !normalizedDefinitionId) {
      throw new HttpError(400, "Field 'id' must not be empty.");
    }

    const sortOrder =
      sortBy === "type"
        ? [asc(definitions.type), asc(definitions.id)]
        : [asc(definitions.id)];

    try {
      if (normalizedDefinitionId) {
        return await db
          .select({
            id: definitions.id,
            type: definitions.type,
            description: definitions.description,
            hash: definitions.hash,
          })
          .from(definitions)
          .where(eq(definitions.id, normalizedDefinitionId))
          .orderBy(...sortOrder);
      }

      const rows = await db
        .select({
          id: definitions.id,
          type: definitions.type,
          description: definitions.description,
          hash: definitions.hash,
        })
        .from(definitions)
        .orderBy(...sortOrder);

      if (!normalizedQuery) {
        return rows;
      }

      return rows.filter(
        (row) =>
          row.id.toLowerCase().includes(normalizedQuery) ||
          row.type.toLowerCase().includes(normalizedQuery) ||
          row.description.toLowerCase().includes(normalizedQuery),
      );
    } catch {
      throw new HttpError(500, "Failed to list definitions.");
    }
  }

  async getDefinition(definitionId: string): Promise<DefinitionResponse> {
    const normalizedDefinitionId = normalizeDefinitionId(definitionId);

    let rows: DefinitionResponse[];
    try {
      rows = await db
        .select({
          id: definitions.id,
          type: definitions.type,
          description: definitions.description,
          hash: definitions.hash,
        })
        .from(definitions)
        .where(eq(definitions.id, normalizedDefinitionId))
        .limit(1);
    } catch {
      throw new HttpError(
        500,
        `Failed to load definition '${normalizedDefinitionId}'.`,
      );
    }

    if (rows.length === 0) {
      throw new HttpError(
        404,
        `Definition '${normalizedDefinitionId}' not found.`,
      );
    }

    return rows[0];
  }

  async createDefinition(
    type: string,
    description: string | undefined,
    content: string,
  ): Promise<DefinitionResponse> {
    const normalizedType = normalizeDefinitionType(type);
    const normalizedDescription = normalizeDefinitionDescription(description);
    const normalizedContent = normalizeDefinitionContent(content);
    const encodedContent = Buffer.from(normalizedContent, "utf8");
    const hash = computeContentHash(normalizedContent);
    const definitionId = randomUUID();

    try {
      await db.insert(definitions).values({
        id: definitionId,
        type: normalizedType,
        description: normalizedDescription,
        content: encodedContent,
        hash,
      });
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      if (isUniqueConstraintViolation(error)) {
        throw new HttpError(
          409,
          "Definition cannot be created because a linked manifest already exists.",
        );
      }

      throw new HttpError(500, "Failed to create definition.");
    }

    return {
      id: definitionId,
      type: normalizedType,
      description: normalizedDescription,
      hash,
    };
  }

  async installDefinitionFromRegistry(
    type: string,
    description: string | undefined,
    fileUrl: string,
  ): Promise<DefinitionResponse> {
    const normalizedFileUrl = normalizeDefinitionFileUrl(fileUrl);

    let response: Response;
    try {
      response = await this.fetchImpl(normalizedFileUrl, {
        method: "GET",
        headers: {
          accept: "application/json, text/plain, application/octet-stream",
        },
      });
    } catch {
      throw new HttpError(
        502,
        `Failed to download definition file from '${normalizedFileUrl}'.`,
      );
    }

    if (!response.ok) {
      throw new HttpError(
        502,
        `Failed to download definition file from '${normalizedFileUrl}' with status ${response.status}.`,
      );
    }

    let content: string;
    try {
      content = await response.text();
    } catch {
      throw new HttpError(
        502,
        `Failed to read definition file downloaded from '${normalizedFileUrl}'.`,
      );
    }

    return this.createDefinition(type, description, content);
  }

  async deleteDefinition(definitionId: string): Promise<void> {
    const normalizedDefinitionId = normalizeDefinitionId(definitionId);

    let deletedRows: Array<{ id: string }>;
    try {
      deletedRows = await db
        .delete(definitions)
        .where(eq(definitions.id, normalizedDefinitionId))
        .returning({ id: definitions.id });
    } catch {
      throw new HttpError(
        500,
        `Failed to delete definition '${normalizedDefinitionId}'.`,
      );
    }

    if (deletedRows.length === 0) {
      throw new HttpError(
        404,
        `Definition '${normalizedDefinitionId}' not found.`,
      );
    }
  }
}

function normalizeDefinitionType(type: string): DefinitionType {
  const normalized = type.trim();

  if (!normalized) {
    throw new HttpError(400, "Field 'type' must not be empty.");
  }

  if (!DEFINITION_TYPES.includes(normalized as DefinitionType)) {
    throw new HttpError(
      400,
      `Field 'type' must be one of: ${DEFINITION_TYPES.join(", ")}.`,
    );
  }

  return normalized as DefinitionType;
}

function normalizeDefinitionContent(content: string): string {
  if (typeof content !== "string") {
    throw new HttpError(400, "Field 'content' must be a string.");
  }

  const normalized = content.trim();

  if (!normalized) {
    throw new HttpError(400, "Field 'content' must not be empty.");
  }

  return normalized;
}

function normalizeDefinitionDescription(
  description: string | undefined,
): string {
  if (description === undefined) {
    return "";
  }

  if (typeof description !== "string") {
    throw new HttpError(400, "Field 'description' must be a string.");
  }

  return description;
}

function normalizeDefinitionId(definitionId: string): string {
  const normalized = definitionId.trim();

  if (!normalized) {
    throw new HttpError(400, "Field 'definitionId' must not be empty.");
  }

  return normalized;
}

function normalizeDefinitionFileUrl(fileUrl: string): string {
  if (typeof fileUrl !== "string") {
    throw new HttpError(400, "Field 'file_url' must be a string.");
  }

  const normalized = fileUrl.trim();

  if (!normalized) {
    throw new HttpError(400, "Field 'file_url' must not be empty.");
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new HttpError(400, "Field 'file_url' must be a valid URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(
      400,
      "Field 'file_url' must use the http or https protocol.",
    );
  }

  return parsed.toString();
}

function normalizeOptionalQuery(query: string | undefined): string | undefined {
  if (query === undefined) {
    return undefined;
  }

  if (typeof query !== "string") {
    throw new HttpError(400, "Field 'query' must be a string.");
  }

  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return undefined;
  }

  return normalized;
}

export function isUniqueConstraintViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeDatabaseError = error as {
    message?: unknown;
    code?: unknown;
  };

  const code =
    typeof maybeDatabaseError.code === "string" ? maybeDatabaseError.code : "";
  if (
    code === "23505" ||
    /^SQLITE_CONSTRAINT_(UNIQUE|PRIMARYKEY)$/i.test(code)
  ) {
    return true;
  }

  const message =
    typeof maybeDatabaseError.message === "string"
      ? maybeDatabaseError.message
      : "";

  return [
    /UNIQUE constraint failed:/i,
    /unique constraint failed/i,
    /duplicate key value/i,
    /\bduplicate key\b/i,
    /violates unique constraint/i,
  ].some((pattern) => pattern.test(message));
}
