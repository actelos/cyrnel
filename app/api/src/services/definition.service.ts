import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

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

const DEFINITION_DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_DEFINITION_DOWNLOAD_BYTES = 1_048_576;

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
    assertRegistryAddressAllowed(normalizedFileUrl);

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, DEFINITION_DOWNLOAD_TIMEOUT_MS);

    let response: Response;
    try {
      response = await this.fetchImpl(normalizedFileUrl, {
        method: "GET",
        headers: {
          accept: "application/json, text/plain, application/octet-stream",
        },
        signal: abortController.signal,
      });
    } catch {
      clearTimeout(timeoutHandle);
      throw new HttpError(
        502,
        `Failed to download definition file from '${normalizedFileUrl}'.`,
      );
    }

    clearTimeout(timeoutHandle);

    if (abortController.signal.aborted) {
      throw new HttpError(
        502,
        `Timed out downloading definition file from '${normalizedFileUrl}'.`,
      );
    }

    assertRegistryAddressAllowed(response.url || normalizedFileUrl);

    if (!response.ok) {
      throw new HttpError(
        502,
        `Failed to download definition file from '${normalizedFileUrl}' with status ${response.status}.`,
      );
    }

    let content: string;
    try {
      content = await readBodyAsUtf8WithLimit(
        response,
        MAX_DEFINITION_DOWNLOAD_BYTES,
      );
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      if (abortController.signal.aborted) {
        throw new HttpError(
          502,
          `Timed out reading definition file downloaded from '${normalizedFileUrl}'.`,
        );
      }

      throw new HttpError(
        502,
        `Failed to read definition file downloaded from '${normalizedFileUrl}'.`,
      );
    }

    if (!content.trim()) {
      throw new HttpError(400, "Field 'content' must not be empty.");
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

function assertRegistryAddressAllowed(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(502, "Registry download redirected to an invalid URL.");
  }

  const hostname = parsed.hostname.trim().toLowerCase();
  const normalizedHost =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  if (normalizedHost === "localhost" || normalizedHost.endsWith(".localhost")) {
    throw new HttpError(
      502,
      "Registry URL resolves to a disallowed local address.",
    );
  }

  if (!isIP(normalizedHost)) {
    return;
  }

  if (isPrivateOrLocalIp(normalizedHost)) {
    throw new HttpError(
      502,
      "Registry URL resolves to a disallowed local address.",
    );
  }
}

function isPrivateOrLocalIp(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const octets = address
      .split(".")
      .map((segment) => Number.parseInt(segment, 10));
    if (
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet))
    ) {
      return true;
    }

    const [a, b] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.") ||
      /^::ffff:172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)
    );
  }

  return true;
}

async function readBodyAsUtf8WithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const declaredContentLength = Number.parseInt(contentLengthHeader, 10);
    if (
      Number.isFinite(declaredContentLength) &&
      declaredContentLength > maxBytes
    ) {
      throw new HttpError(
        413,
        `Definition file exceeds maximum allowed size of ${maxBytes} bytes.`,
      );
    }
  }

  if (!response.body) {
    throw new HttpError(
      502,
      "Downloaded definition file did not include a response body.",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const chunks: string[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new HttpError(
            413,
            `Definition file exceeds maximum allowed size of ${maxBytes} bytes.`,
          );
        }

        chunks.push(decoder.decode(value, { stream: true }));
      }
    }

    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
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
