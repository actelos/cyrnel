import { readFile } from "node:fs/promises";

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

  async listServices(): Promise<ServiceManifestResponse[]> {
    let serviceRows: Array<{ id: string; hash: string }>;
    let toolRows: ToolDefinitionResponse[];

    try {
      serviceRows = await db
        .select({ id: manifests.id, hash: manifests.hash })
        .from(manifests);
      toolRows = await db
        .select({
          serviceName: tools.serviceName,
          name: tools.name,
          inputSchema: tools.inputSchema,
          outputSchema: tools.outputSchema,
        })
        .from(tools)
        .orderBy(asc(tools.serviceName), asc(tools.name));
    } catch {
      throw new HttpError(500, "Failed to list service manifests.");
    }

    const toolMap = new Map<string, PublicToolDefinition[]>();

    for (const tool of toolRows) {
      const existing = toolMap.get(tool.serviceName) ?? [];
      existing.push({
        name: tool.name,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      });
      toolMap.set(tool.serviceName, existing);
    }

    return serviceRows.map((row) => ({
      name: row.id,
      hash: row.hash,
      tools: toolMap.get(row.id) ?? [],
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
        .where(eq(tools.serviceName, normalizedServiceName))
        .orderBy(asc(tools.name));
    } catch {
      throw new HttpError(
        500,
        `Failed to load tools for service '${normalizedServiceName}'.`,
      );
    }

    for (const tool of toolRows) {
      if (!isToolDefinition(tool)) {
        const invalidToolName =
          isRecord(tool) && typeof tool.name === "string"
            ? tool.name
            : "unknown";
        throw new HttpError(
          500,
          `Stored tool '${invalidToolName}' for service '${normalizedServiceName}' is invalid.`,
        );
      }
    }

    const validatedTools = toolRows as ToolDefinition[];

    return {
      name: rows[0].id,
      hash: rows[0].hash,
      metadata,
      tools: validatedTools,
    };
  }

  async createService(
    serviceName: string,
    definitionId: string,
  ): Promise<void> {
    const normalizedServiceName = normalizeServiceName(serviceName);
    const normalizedDefinitionId = normalizeDefinitionId(definitionId);

    let definitionRow: {
      id: string;
      path: string;
      hash: string;
    } | null = null;

    try {
      const rows = await db
        .select({
          id: definitions.id,
          path: definitions.path,
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

    let definitionContent: string;
    try {
      definitionContent = await readFile(definitionRow.path, "utf8");
    } catch {
      throw new HttpError(
        500,
        `Failed to load definition content for '${normalizedDefinitionId}'.`,
      );
    }

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

  async listTools(toolName?: string): Promise<ToolDefinitionResponse[]> {
    const normalizedToolName =
      typeof toolName === "string" ? normalizeToolName(toolName) : undefined;

    try {
      if (normalizedToolName) {
        return await db
          .select({
            serviceName: tools.serviceName,
            name: tools.name,
            inputSchema: tools.inputSchema,
            outputSchema: tools.outputSchema,
          })
          .from(tools)
          .where(eq(tools.name, normalizedToolName))
          .orderBy(asc(tools.serviceName), asc(tools.name));
      }

      return await db
        .select({
          serviceName: tools.serviceName,
          name: tools.name,
          inputSchema: tools.inputSchema,
          outputSchema: tools.outputSchema,
        })
        .from(tools)
        .orderBy(asc(tools.serviceName), asc(tools.name));
    } catch {
      if (normalizedToolName) {
        throw new HttpError(
          500,
          `Failed to list tools named '${normalizedToolName}'.`,
        );
      }

      throw new HttpError(500, "Failed to list tools.");
    }
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
