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
}

export class DefinitionService {
  private readonly fetchImpl: typeof fetch;

  constructor(options: DefinitionServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listDefinitions(
    options: ListDefinitionsOptions = {},
  ): Promise<DefinitionResponse[]> {
    const { sortBy, definitionId } = options;
    const normalizedDefinitionId = definitionId?.trim();

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
            hash: definitions.hash,
          })
          .from(definitions)
          .where(eq(definitions.id, normalizedDefinitionId))
          .orderBy(...sortOrder);
      }

      return await db
        .select({
          id: definitions.id,
          type: definitions.type,
          hash: definitions.hash,
        })
        .from(definitions)
        .orderBy(...sortOrder);
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
    content: string,
  ): Promise<DefinitionResponse> {
    const normalizedType = normalizeDefinitionType(type);
    const normalizedContent = normalizeDefinitionContent(content);
    const encodedContent = Buffer.from(normalizedContent, "utf8");
    const hash = computeContentHash(normalizedContent);
    const definitionId = randomUUID();

    try {
      await db.insert(definitions).values({
        id: definitionId,
        type: normalizedType,
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
      hash,
    };
  }

  async installDefinitionFromRegistry(
    type: string,
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

    return this.createDefinition(type, content);
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

function isUniqueConstraintViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /unique|constraint/i.test(error.message);
}
