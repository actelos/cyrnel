import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { manifests } from "@/db/schema";
import { HttpError } from "@/models/error.model";
import type {
  JSONSchema,
  ManifestTool,
  ServiceManifest,
  ToolDefinition,
} from "@/models/manifest.model";

type ManifestLoader = (serviceId: string) => Promise<ServiceManifest | null>;

export interface ServiceManifestSummary {
  name: string;
}

export class ManifestService {
  constructor(private readonly loadManifest: ManifestLoader = loadManifestByServiceId) {}

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
    const normalizedToolId = toolId.trim();

    if (!normalizedToolId) {
      throw new HttpError(400, "Tool id must not be empty.");
    }

    let manifest: ServiceManifest | null;
    try {
      manifest = await this.loadManifest(normalizedServiceId);
    } catch {
      throw new HttpError(
        500,
        `Failed to load manifest for service '${normalizedServiceId}'.`,
      );
    }

    if (!manifest) {
      throw new HttpError(
        404,
        `Manifest not found for service '${normalizedServiceId}'.`,
      );
    }

    const { metadata, tools } = normalizeStoredManifest(
      manifest,
      normalizedServiceId,
    );

    const tool = tools.find((item) => item.name === normalizedToolId);

    if (!tool) {
      throw new HttpError(
        404,
        `Tool '${normalizedToolId}' not found in manifest for service '${normalizedServiceId}'.`,
      );
    }

    return {
      tool,
      serviceMetadata: metadata,
    };
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

function normalizeStoredManifest(
  manifest: ServiceManifest,
  serviceId: string,
): ServiceManifest {
  if (!isRecord(manifest.metadata)) {
    throw new HttpError(
      500,
      `Stored manifest for service '${serviceId}' has invalid metadata.`,
    );
  }

  if (!Array.isArray(manifest.tools)) {
    throw new HttpError(
      500,
      `Stored manifest for service '${serviceId}' has invalid tools.`,
    );
  }

  const tools = manifest.tools.filter((tool, index) => {
    if (isToolDefinition(tool)) {
      return true;
    }

    throw new HttpError(
      500,
      `Stored manifest for service '${serviceId}' has an invalid tool at index ${index}.`,
    );
  });

  if (tools.length === 0) {
    throw new HttpError(
      500,
      `Stored manifest for service '${serviceId}' has no tools.`,
    );
  }

  return {
    metadata: manifest.metadata,
    tools,
  };
}

async function loadManifestByServiceId(serviceId: string): Promise<ServiceManifest | null> {
  const rows = await db
    .select({
      metadata: manifests.metadata,
      tools: manifests.tools,
    })
    .from(manifests)
    .where(eq(manifests.id, serviceId))
    .limit(1);

  if (rows.length === 0) {
    return null;
  }

  return {
    metadata: rows[0].metadata,
    tools: rows[0].tools,
  };
}

function isToolDefinition(value: unknown): value is ToolDefinition {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    isSchema(value.inputSchema) &&
    isSchema(value.outputSchema) &&
    isRecord(value.metadata)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSchema(value: unknown): value is JSONSchema {
  return isRecord(value);
}
