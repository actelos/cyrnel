import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { manifests, tools } from "@/db/schema";
import { HttpError } from "@/models/error.model";
import type {
  ManifestMetadata,
  ManifestTool,
  PublicToolDefinition,
  ToolDefinition,
} from "@/models/manifest.model";

type ServiceMetadataLoader = (
  serviceId: string,
) => Promise<ManifestMetadata | null>;
type ToolLoader = (
  serviceId: string,
  toolId: string,
) => Promise<ToolDefinition | null>;

export interface ServiceManifestSummary {
  name: string;
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
      throw new HttpError(
        500,
        `Failed to list tools named '${normalizedToolName}'.`,
      );
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

  async getService(serviceId: string): Promise<ServiceManifestSummary> {
    const normalizedServiceId = normalizeServiceId(serviceId);

    let rows: Array<{ id: string }>;
    try {
      rows = await db
        .select({ id: manifests.id })
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

    return { name: rows[0].id };
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
