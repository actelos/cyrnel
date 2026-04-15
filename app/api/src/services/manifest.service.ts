import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { definitions, manifests, tools } from "@/db/schema";
import { HttpError } from "@/models/error.model";
import type { ResolvedToolInvocation } from "@/models/invoke.model";
import type {
  ManifestMetadata,
  PublicToolDefinition,
  ServiceManifest,
  ServiceManifestDetails,
  ServiceManifestResponse,
  ToolDefinition,
  ToolDefinitionResponse,
} from "@/models/manifest.model";
import { AdapterModule } from "@/modules/adapter.module";

type ServiceMetadataLoader = (
  serviceName: string,
) => Promise<ManifestMetadata | null>;
type ToolLoader = (
  serviceName: string,
  toolName: string,
) => Promise<ToolDefinition | null>;

export class ManifestService {
  constructor(
    private readonly loadServiceMetadata: ServiceMetadataLoader = loadServiceMetadataByServiceName,
    private readonly loadToolByName: ToolLoader = loadToolByServiceAndToolName,
    private readonly adapter: AdapterModule = new AdapterModule(),
  ) {}

  async listServices(query?: string): Promise<ServiceManifestResponse[]> {
    let rows: Array<{ id: string; hash: string }>;

    try {
      rows = await db
        .select({ id: manifests.id, hash: manifests.hash })
        .from(manifests)
        .orderBy(asc(manifests.id));
    } catch {
      throw new HttpError(500, "Failed to list service manifests.");
    }

    const loweredQuery = query?.toLowerCase();

    const filtered =
      loweredQuery === undefined
        ? rows
        : rows.filter((row) => row.id.toLowerCase().includes(loweredQuery));

    return filtered.map((row) => ({
      name: row.id,
      hash: row.hash,
    }));
  }

  async getService(serviceName: string): Promise<ServiceManifestDetails> {
    const normalizedServiceName = normalizeServiceName(serviceName);

    let rows: Array<{ id: string; metadata: ManifestMetadata; hash: string }>;
    try {
      rows = await db
        .select({
          id: manifests.id,
          metadata: manifests.metadata,
          hash: manifests.hash,
        })
        .from(manifests)
        .where(eq(manifests.id, normalizedServiceName))
        .limit(1);
    } catch {
      throw new HttpError(
        500,
        `Failed to load manifest for service '${normalizedServiceName}'.`,
      );
    }

    if (rows.length === 0) {
      throw new HttpError(
        404,
        `Manifest not found for service '${normalizedServiceName}'.`,
      );
    }

    const metadata = rows[0].metadata;
    if (!isRecord(metadata)) {
      throw new HttpError(
        500,
        `Stored manifest for service '${normalizedServiceName}' has invalid metadata.`,
      );
    }

    return {
      name: rows[0].id,
      hash: rows[0].hash,
      metadata,
    };
  }

  async listTools(
    serviceName: string,
    query?: string,
  ): Promise<PublicToolDefinition[]> {
    const normalizedServiceName = normalizeServiceName(serviceName);

    let serviceRows: Array<{ id: string }>;
    try {
      serviceRows = await db
        .select({ id: manifests.id })
        .from(manifests)
        .where(eq(manifests.id, normalizedServiceName))
        .limit(1);
    } catch {
      throw new HttpError(
        500,
        `Failed to load manifest for service '${normalizedServiceName}'.`,
      );
    }

    if (serviceRows.length === 0) {
      throw new HttpError(
        404,
        `Manifest not found for service '${normalizedServiceName}'.`,
      );
    }

    let rows: ToolDefinitionResponse[];
    try {
      rows = await db
        .select({
          serviceName: tools.serviceName,
          name: tools.name,
          inputSchema: tools.inputSchema,
          outputSchema: tools.outputSchema,
        })
        .from(tools)
        .where(eq(tools.serviceName, normalizedServiceName))
        .orderBy(asc(tools.name));
    } catch {
      throw new HttpError(
        500,
        `Failed to load tools for service '${normalizedServiceName}'.`,
      );
    }

    const loweredQuery = query?.toLowerCase();

    const filtered =
      loweredQuery === undefined
        ? rows
        : rows.filter((row) => row.name.toLowerCase().includes(loweredQuery));

    return filtered.map((row) => ({
      name: row.name,
      inputSchema: row.inputSchema,
      outputSchema: row.outputSchema,
    }));
  }

  async createService(
    serviceName: string,
    definitionId: string,
  ): Promise<void> {
    const normalizedServiceName = normalizeServiceName(serviceName);
    const normalizedDefinitionId = normalizeDefinitionId(definitionId);

    let definitionRow: {
      id: string;
      content: Buffer;
      hash: string;
    } | null = null;

    try {
      const rows = await db
        .select({
          id: definitions.id,
          content: definitions.content,
          hash: definitions.hash,
        })
        .from(definitions)
        .where(eq(definitions.id, normalizedDefinitionId))
        .limit(1);

      definitionRow = rows[0] ?? null;
    } catch {
      throw new HttpError(
        500,
        `Failed to load definition '${normalizedDefinitionId}'.`,
      );
    }

    if (!definitionRow) {
      throw new HttpError(
        404,
        `Definition '${normalizedDefinitionId}' not found.`,
      );
    }

    const definitionContent = decodeDefinitionContent(definitionRow.content);

    const parsedManifest = await parseRegisteredManifest(
      this.adapter,
      definitionContent,
      normalizedServiceName,
    );

    try {
      await db.transaction(async (tx) => {
        await tx.insert(manifests).values({
          id: normalizedServiceName,
          definitionId: normalizedDefinitionId,
          hash: definitionRow.hash,
          metadata: parsedManifest.metadata,
        });

        if (parsedManifest.tools.length > 0) {
          await tx.insert(tools).values(
            parsedManifest.tools.map((tool) => ({
              serviceName: normalizedServiceName,
              name: tool.name,
              metadata: tool.metadata,
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema,
            })),
          );
        }
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new HttpError(
          409,
          `Manifest already exists for service '${normalizedServiceName}'.`,
        );
      }

      throw new HttpError(
        500,
        `Failed to create manifest for service '${normalizedServiceName}'.`,
      );
    }
  }

  async deleteService(serviceName: string): Promise<void> {
    const normalizedServiceName = normalizeServiceName(serviceName);

    let deletedRows: Array<{ id: string }>;
    try {
      deletedRows = await db
        .delete(manifests)
        .where(eq(manifests.id, normalizedServiceName))
        .returning({ id: manifests.id });
    } catch {
      throw new HttpError(
        500,
        `Failed to delete manifest for service '${normalizedServiceName}'.`,
      );
    }

    if (deletedRows.length === 0) {
      throw new HttpError(
        404,
        `Manifest not found for service '${normalizedServiceName}'.`,
      );
    }
  }

  async updateService(
    serviceName: string,
    definitionId: string,
  ): Promise<boolean> {
    const normalizedServiceName = normalizeServiceName(serviceName);
    const normalizedDefinitionId = normalizeDefinitionId(definitionId);

    let manifestRow: {
      id: string;
      hash: string;
    } | null = null;

    try {
      const rows = await db
        .select({
          id: manifests.id,
          hash: manifests.hash,
        })
        .from(manifests)
        .where(eq(manifests.id, normalizedServiceName))
        .limit(1);

      manifestRow = rows[0] ?? null;
    } catch {
      throw new HttpError(
        500,
        `Failed to load manifest for service '${normalizedServiceName}'.`,
      );
    }

    if (!manifestRow) {
      throw new HttpError(
        404,
        `Manifest not found for service '${normalizedServiceName}'.`,
      );
    }

    let definitionRow: {
      id: string;
      content: Buffer;
      hash: string;
    } | null = null;

    try {
      const rows = await db
        .select({
          id: definitions.id,
          content: definitions.content,
          hash: definitions.hash,
        })
        .from(definitions)
        .where(eq(definitions.id, normalizedDefinitionId))
        .limit(1);

      definitionRow = rows[0] ?? null;
    } catch {
      throw new HttpError(
        500,
        `Failed to load definition '${normalizedDefinitionId}'.`,
      );
    }

    if (!definitionRow) {
      throw new HttpError(
        404,
        `Definition '${normalizedDefinitionId}' not found.`,
      );
    }

    if (manifestRow.hash === definitionRow.hash) {
      return false;
    }

    const definitionContent = decodeDefinitionContent(definitionRow.content);
    const parsedManifest = await parseRegisteredManifest(
      this.adapter,
      definitionContent,
      normalizedServiceName,
    );

    try {
      await db.transaction(async (tx) => {
        await tx
          .update(manifests)
          .set({
            definitionId: normalizedDefinitionId,
            hash: definitionRow.hash,
            metadata: parsedManifest.metadata,
          })
          .where(eq(manifests.id, normalizedServiceName));

        await tx
          .delete(tools)
          .where(eq(tools.serviceName, normalizedServiceName));

        if (parsedManifest.tools.length > 0) {
          await tx.insert(tools).values(
            parsedManifest.tools.map((tool) => ({
              serviceName: normalizedServiceName,
              name: tool.name,
              metadata: tool.metadata,
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema,
            })),
          );
        }
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new HttpError(
          409,
          `Definition '${normalizedDefinitionId}' is already linked to another service.`,
        );
      }

      throw new HttpError(
        500,
        `Failed to update manifest for service '${normalizedServiceName}'.`,
      );
    }

    return true;
  }

  async discoverTools(
    query: string,
    limit?: number,
  ): Promise<ToolDefinitionResponse[]> {
    const normalizedQuery = normalizeDiscoverQuery(query);
    const normalizedLimit = normalizeDiscoverLimit(limit);

    let rows: ToolDefinitionResponse[];
    try {
      rows = await db
        .select({
          serviceName: tools.serviceName,
          name: tools.name,
          inputSchema: tools.inputSchema,
          outputSchema: tools.outputSchema,
        })
        .from(tools)
        .orderBy(asc(tools.serviceName), asc(tools.name));
    } catch {
      throw new HttpError(500, "Failed to discover tools.");
    }

    if (normalizedQuery.length === 0) {
      return applyDiscoverLimit(rows, normalizedLimit);
    }

    const loweredQuery = normalizedQuery.toLowerCase();

    const filtered = rows.filter(
      (row) =>
        row.name.toLowerCase().includes(loweredQuery) ||
        row.serviceName.toLowerCase().includes(loweredQuery),
    );

    return applyDiscoverLimit(filtered, normalizedLimit);
  }

  async discoverServices(
    query: string,
    limit?: number,
  ): Promise<ServiceManifestResponse[]> {
    const normalizedQuery = normalizeDiscoverQuery(query);
    const normalizedLimit = normalizeDiscoverLimit(limit);
    const services = await this.listServices();

    if (normalizedQuery.length === 0) {
      return applyDiscoverLimit(services, normalizedLimit);
    }

    const loweredQuery = normalizedQuery.toLowerCase();

    const filtered = services.filter((service) =>
      service.name.toLowerCase().includes(loweredQuery),
    );

    return applyDiscoverLimit(filtered, normalizedLimit);
  }

  async getTool(
    serviceName: string,
    toolName: string,
  ): Promise<ResolvedToolInvocation> {
    const normalizedServiceName = normalizeServiceName(serviceName);
    const normalizedToolName = normalizeToolName(toolName);

    let serviceMetadata: ManifestMetadata | null;
    try {
      serviceMetadata = await this.loadServiceMetadata(normalizedServiceName);
    } catch {
      throw new HttpError(
        500,
        `Failed to load manifest for service '${normalizedServiceName}'.`,
      );
    }

    if (!serviceMetadata) {
      throw new HttpError(
        404,
        `Manifest not found for service '${normalizedServiceName}'.`,
      );
    }

    let tool: ToolDefinition | null;
    try {
      tool = await this.loadToolByName(
        normalizedServiceName,
        normalizedToolName,
      );
    } catch {
      throw new HttpError(
        500,
        `Failed to load tool '${normalizedToolName}' for service '${normalizedServiceName}'.`,
      );
    }

    if (!tool) {
      throw new HttpError(
        404,
        `Tool '${normalizedToolName}' not found in manifest for service '${normalizedServiceName}'.`,
      );
    }

    return {
      tool,
      serviceMetadata,
    };
  }
}

function decodeDefinitionContent(content: Buffer | Uint8Array): string {
  if (Buffer.isBuffer(content)) {
    return content.toString("utf8");
  }

  return Buffer.from(content).toString("utf8");
}

async function parseRegisteredManifest(
  adapter: AdapterModule,
  definitionContent: string,
  expectedServiceName: string,
): Promise<ServiceManifest> {
  try {
    const parsedManifest = await adapter.register(definitionContent);

    if (parsedManifest.name !== expectedServiceName) {
      throw new HttpError(
        400,
        `Manifest name '${parsedManifest.name}' must match service name '${expectedServiceName}'.`,
      );
    }

    return parsedManifest satisfies ServiceManifest;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    throw new HttpError(
      400,
      error instanceof Error ? error.message : "Invalid definition content.",
    );
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /unique|constraint/i.test(error.message);
}

function normalizeServiceName(serviceName: string): string {
  const normalized = serviceName.trim();

  if (!normalized) {
    throw new HttpError(400, "Service name must not be empty.");
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) {
    throw new HttpError(
      400,
      "Service name may only contain letters, numbers, dot, underscore, and hyphen.",
    );
  }

  return normalized;
}

function normalizeToolName(toolName: string): string {
  const normalized = toolName.trim();

  if (!normalized) {
    throw new HttpError(400, "Tool name must not be empty.");
  }

  return normalized;
}

function normalizeDiscoverQuery(query: string): string {
  if (typeof query !== "string") {
    throw new HttpError(400, "Field 'query' must be a string.");
  }

  return query.trim();
}

function normalizeDiscoverLimit(limit: unknown): number | undefined {
  if (limit === undefined) {
    return undefined;
  }

  if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
    throw new HttpError(400, "Field 'limit' must be a positive integer.");
  }

  return limit;
}

function applyDiscoverLimit<T>(items: T[], limit: number | undefined): T[] {
  if (limit === undefined) {
    return items;
  }

  return items.slice(0, limit);
}

function normalizeDefinitionId(definitionId: string): string {
  const normalized = definitionId.trim();

  if (!normalized) {
    throw new HttpError(400, "Field 'definitionId' must not be empty.");
  }

  return normalized;
}

async function loadServiceMetadataByServiceName(
  serviceName: string,
): Promise<ManifestMetadata | null> {
  const rows = await db
    .select({ metadata: manifests.metadata })
    .from(manifests)
    .where(eq(manifests.id, serviceName))
    .limit(1);

  if (rows.length === 0) {
    return null;
  }

  const metadata = rows[0].metadata;
  if (!isRecord(metadata)) {
    throw new HttpError(
      500,
      `Stored manifest for service '${serviceName}' has invalid metadata.`,
    );
  }

  return metadata;
}

async function loadToolByServiceAndToolName(
  serviceName: string,
  toolName: string,
): Promise<ToolDefinition | null> {
  const rows = await db
    .select({
      name: tools.name,
      inputSchema: tools.inputSchema,
      outputSchema: tools.outputSchema,
      metadata: tools.metadata,
    })
    .from(tools)
    .where(and(eq(tools.serviceName, serviceName), eq(tools.name, toolName)))
    .limit(1);

  if (rows.length === 0) {
    return null;
  }

  const tool = rows[0];
  if (!isToolDefinition(tool)) {
    throw new HttpError(
      500,
      `Stored tool '${toolName}' for service '${serviceName}' is invalid.`,
    );
  }

  return tool;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isToolDefinition(value: unknown): value is ToolDefinition {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    isRecord(value.inputSchema) &&
    isRecord(value.outputSchema) &&
    isRecord(value.metadata)
  );
}
