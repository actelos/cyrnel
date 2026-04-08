import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { manifests, tools } from "@/db/schema";
import { HttpError } from "@/models/error.model";
import type {
  ManifestMetadata,
  ManifestTool,
  PublicToolDefinition,
  ServiceManifest,
  ToolDefinition,
} from "@/models/manifest.model";
import { parseServiceManifest } from "@/modules/adapter.module";

type ServiceMetadataLoader = (serviceId: string) => Promise<ManifestMetadata | null>;
type ToolLoader = (serviceId: string, toolId: string) => Promise<ToolDefinition | null>;

export interface ServiceManifestSummary {
  name: string;
}

export interface ServiceManifestDetails {
  name: string;
  metadata: ManifestMetadata;
  tools: ToolDefinition[];
}

export class ManifestService {
  constructor(
    private readonly loadServiceMetadata: ServiceMetadataLoader = loadServiceMetadataByServiceId,
    private readonly loadToolById: ToolLoader = loadToolByServiceAndToolId,
  ) {}

  async getToolByName(toolName: string): Promise<PublicToolDefinition> {
    const normalizedToolName = normalizeToolId(toolName);

    let rows: Array<PublicToolDefinition>;
    try {
      rows = await db
        .select({
          serviceId: tools.serviceId,
          name: tools.name,
          inputSchema: tools.inputSchema,
          outputSchema: tools.outputSchema,
        })
        .from(tools)
        .where(eq(tools.name, normalizedToolName))
        .orderBy(asc(tools.serviceId))
        .limit(1);
    } catch {
      throw new HttpError(500, `Failed to load tool '${normalizedToolName}'.`);
    }

    if (rows.length === 0) {
      throw new HttpError(404, `Tool '${normalizedToolName}' not found.`);
    }

    return rows[0];
  }

  async listToolsByName(toolName: string): Promise<PublicToolDefinition[]> {
    const normalizedToolName = normalizeToolId(toolName);

    try {
      return await db
        .select({
          serviceId: tools.serviceId,
          name: tools.name,
          inputSchema: tools.inputSchema,
          outputSchema: tools.outputSchema,
        })
        .from(tools)
        .where(eq(tools.name, normalizedToolName))
        .orderBy(asc(tools.serviceId));
    } catch {
      throw new HttpError(500, `Failed to list tools named '${normalizedToolName}'.`);
    }
  }

  async listServices(): Promise<ServiceManifestSummary[]> {
    let rows: Array<{ id: string }>;

    try {
      rows = await db.select({ id: manifests.id }).from(manifests);
    } catch {
      throw new HttpError(500, "Failed to list service manifests.");
    }

    return rows.map((row) => ({ name: row.id }));
  }

  async getService(serviceId: string): Promise<ServiceManifestDetails> {
    const normalizedServiceId = normalizeServiceId(serviceId);

    let rows: Array<{ id: string; metadata: ManifestMetadata }>;
    try {
      rows = await db
        .select({ id: manifests.id, metadata: manifests.metadata })
        .from(manifests)
        .where(eq(manifests.id, normalizedServiceId))
        .limit(1);
    } catch {
      throw new HttpError(
        500,
        `Failed to load manifest for service '${normalizedServiceId}'.`,
      );
    }

    if (rows.length === 0) {
      throw new HttpError(
        404,
        `Manifest not found for service '${normalizedServiceId}'.`,
      );
    }

    const metadata = rows[0].metadata;
    if (!isRecord(metadata)) {
      throw new HttpError(
        500,
        `Stored manifest for service '${normalizedServiceId}' has invalid metadata.`,
      );
    }

    let toolRows: unknown[];
    try {
      toolRows = await db
        .select({
          name: tools.name,
          inputSchema: tools.inputSchema,
          outputSchema: tools.outputSchema,
          metadata: tools.metadata,
        })
        .from(tools)
        .where(eq(tools.serviceId, normalizedServiceId))
        .orderBy(asc(tools.name));
    } catch {
      throw new HttpError(
        500,
        `Failed to load tools for service '${normalizedServiceId}'.`,
      );
    }

    for (const tool of toolRows) {
      if (!isToolDefinition(tool)) {
        const invalidToolName =
          isRecord(tool) && typeof tool.name === "string" ? tool.name : "unknown";
        throw new HttpError(
          500,
          `Stored tool '${invalidToolName}' for service '${normalizedServiceId}' is invalid.`,
        );
      }
    }

    const validatedTools = toolRows as ToolDefinition[];

    return {
      name: rows[0].id,
      metadata,
      tools: validatedTools,
    };
  }

  async createService(serviceId: string, manifestSource: string): Promise<void> {
    const normalizedServiceId = normalizeServiceId(serviceId);
    const parsedManifest = parseManifestSource(manifestSource);

    try {
      await db.transaction(async (tx) => {
        await tx.insert(manifests).values({
          id: normalizedServiceId,
          metadata: parsedManifest.metadata,
        });

        if (parsedManifest.tools.length > 0) {
          await tx.insert(tools).values(
            parsedManifest.tools.map((tool) => ({
              serviceId: normalizedServiceId,
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
          `Manifest already exists for service '${normalizedServiceId}'.`,
        );
      }

      throw new HttpError(
        500,
        `Failed to create manifest for service '${normalizedServiceId}'.`,
      );
    }
  }

  async updateService(serviceId: string, manifestSource: string): Promise<void> {
    const normalizedServiceId = normalizeServiceId(serviceId);
    const parsedManifest = parseManifestSource(manifestSource);

    try {
      await db.transaction(async (tx) => {
        const updatedRows = await tx
          .update(manifests)
          .set({ metadata: parsedManifest.metadata })
          .where(eq(manifests.id, normalizedServiceId))
          .returning({ id: manifests.id });

        if (updatedRows.length === 0) {
          throw new HttpError(
            404,
            `Manifest not found for service '${normalizedServiceId}'.`,
          );
        }

        await tx.delete(tools).where(eq(tools.serviceId, normalizedServiceId));

        if (parsedManifest.tools.length > 0) {
          await tx.insert(tools).values(
            parsedManifest.tools.map((tool) => ({
              serviceId: normalizedServiceId,
              name: tool.name,
              metadata: tool.metadata,
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema,
            })),
          );
        }
      });
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      throw new HttpError(
        500,
        `Failed to update manifest for service '${normalizedServiceId}'.`,
      );
    }
  }

  async getTool(serviceId: string, toolId: string): Promise<ManifestTool> {
    const normalizedServiceId = normalizeServiceId(serviceId);
    const normalizedToolId = normalizeToolId(toolId);

    let serviceMetadata: ManifestMetadata | null;
    try {
      serviceMetadata = await this.loadServiceMetadata(normalizedServiceId);
    } catch {
      throw new HttpError(
        500,
        `Failed to load manifest for service '${normalizedServiceId}'.`,
      );
    }

    if (!serviceMetadata) {
      throw new HttpError(
        404,
        `Manifest not found for service '${normalizedServiceId}'.`,
      );
    }

    let tool: ToolDefinition | null;
    try {
      tool = await this.loadToolById(normalizedServiceId, normalizedToolId);
    } catch {
      throw new HttpError(
        500,
        `Failed to load tool '${normalizedToolId}' for service '${normalizedServiceId}'.`,
      );
    }

    if (!tool) {
      throw new HttpError(
        404,
        `Tool '${normalizedToolId}' not found in manifest for service '${normalizedServiceId}'.`,
      );
    }

    return {
      tool,
      serviceMetadata,
    };
  }

  async deleteService(serviceId: string): Promise<void> {
    const normalizedServiceId = normalizeServiceId(serviceId);

    let deletedRows: Array<{ id: string }>;
    try {
      deletedRows = await db
        .delete(manifests)
        .where(eq(manifests.id, normalizedServiceId))
        .returning({ id: manifests.id });
    } catch {
      throw new HttpError(
        500,
        `Failed to delete manifest for service '${normalizedServiceId}'.`,
      );
    }

    if (deletedRows.length === 0) {
      throw new HttpError(
        404,
        `Manifest not found for service '${normalizedServiceId}'.`,
      );
    }
  }
}

function parseManifestSource(manifestSource: string): ServiceManifest {
  if (typeof manifestSource !== "string") {
    throw new HttpError(400, "Field 'manifest' must be a JSON string.");
  }

  try {
    return parseServiceManifest(manifestSource);
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : "Invalid manifest JSON.",
    );
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /unique|constraint/i.test(error.message);
}

function normalizeServiceId(serviceId: string): string {
  const normalized = serviceId.trim();

  if (!normalized) {
    throw new HttpError(400, "Service id must not be empty.");
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) {
    throw new HttpError(
      400,
      "Service id may only contain letters, numbers, dot, underscore, and hyphen.",
    );
  }

  return normalized;
}

function normalizeToolId(toolId: string): string {
  const normalized = toolId.trim();

  if (!normalized) {
    throw new HttpError(400, "Tool id must not be empty.");
  }

  return normalized;
}

async function loadServiceMetadataByServiceId(
  serviceId: string,
): Promise<ManifestMetadata | null> {
  const rows = await db
    .select({ metadata: manifests.metadata })
    .from(manifests)
    .where(eq(manifests.id, serviceId))
    .limit(1);

  if (rows.length === 0) {
    return null;
  }

  const metadata = rows[0].metadata;
  if (!isRecord(metadata)) {
    throw new HttpError(
      500,
      `Stored manifest for service '${serviceId}' has invalid metadata.`,
    );
  }

  return metadata;
}

async function loadToolByServiceAndToolId(
  serviceId: string,
  toolId: string,
): Promise<ToolDefinition | null> {
  const rows = await db
    .select({
      name: tools.name,
      inputSchema: tools.inputSchema,
      outputSchema: tools.outputSchema,
      metadata: tools.metadata,
    })
    .from(tools)
    .where(and(eq(tools.serviceId, serviceId), eq(tools.name, toolId)))
    .limit(1);

  if (rows.length === 0) {
    return null;
  }

  const tool = rows[0];
  if (!isToolDefinition(tool)) {
    throw new HttpError(
      500,
      `Stored tool '${toolId}' for service '${serviceId}' is invalid.`,
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
