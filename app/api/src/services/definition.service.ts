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

export class DefinitionService {
  async listDefinitions(): Promise<DefinitionResponse[]> {
    try {
      return await db
        .select({
          id: definitions.id,
          type: definitions.type,
          hash: definitions.hash,
        })
        .from(definitions)
        .orderBy(asc(definitions.id));
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

function isUniqueConstraintViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /unique|constraint/i.test(error.message);
}
