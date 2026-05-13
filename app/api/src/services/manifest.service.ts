import { and, asc, eq } from "drizzle-orm";
import type { Operation } from "fast-json-patch";
import { applyPatch } from "fast-json-patch";
import * as ipaddr from "ipaddr.js";
import { z } from "zod";
import { db } from "@/db/client";
import { configurations, manifests, secrets, tools } from "@/db/schema";
import { logger } from "@/logger";
import { HttpError } from "@/models/error.model";
import type { ResolvedToolInvocation } from "@/models/invoke.model";
import type {
  JSONSchema,
  ManifestMetadata,
  ServiceDetails,
  ServiceInstallRequest,
  ServiceListItem,
  ServiceManifestDefinition,
  ServiceToolDefinition,
  ServiceType,
  StagedServiceEntry,
  ToolDiscoverItem,
  ToolListItem,
} from "@/models/manifest.model";
import { AdapterModule } from "@/modules/adapter.module";
import { computeContentHash } from "@/utils/hash.util";
import type { EncryptedSecretsPayload } from "@/utils/secrets.util";
import {
  decryptSecrets,
  encryptSecrets,
  normalizeSecrets,
} from "@/utils/secrets.util";
import {
  applyJsonSchemaDefaults,
  validateJsonSchema,
} from "@/utils/validation.util";

const DEFINITION_DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_DEFINITION_DOWNLOAD_BYTES = 2_048_576;

const metadataSchema = z.record(z.string(), z.unknown());

const persistedToolSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string(),
  enabled: z.boolean(),
  inputSchema: metadataSchema,
  outputSchema: metadataSchema,
  metadata: metadataSchema,
});

const encryptedSecretsSchema = z.object({
  alg: z.literal("aes-256-gcm"),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

type ServiceMetadataLoader = (
  serviceName: string,
) => Promise<{ metadata: ManifestMetadata; enabled: boolean } | null>;
type ToolLoader = (
  serviceName: string,
  toolName: string,
) => Promise<ServiceToolDefinition | null>;

export class ManifestService {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly loadServiceMetadata: ServiceMetadataLoader = loadServiceMetadataByServiceName,
    private readonly loadToolByName: ToolLoader = loadToolByServiceAndToolName,
    private readonly adapter: AdapterModule = new AdapterModule(),
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  async listServices(
    query?: string,
    enabled: boolean | null = null,
  ): Promise<ServiceListItem[]> {
    let rows: Array<{
      id: string;
      type: ServiceType;
      source: string;
      description: string;
      hash: string;
      enabled: boolean;
    }>;

    try {
      rows = await db
        .select({
          id: manifests.id,
          type: manifests.type,
          source: manifests.source,
          description: manifests.description,
          hash: manifests.hash,
          enabled: manifests.enabled,
        })
        .from(manifests)
        .orderBy(asc(manifests.id));
    } catch {
      throw new HttpError(500, "Failed to list service manifests.");
    }

    const loweredQuery = query?.toLowerCase();
    const normalizedEnabled = normalizeListEnabled(enabled);

    const queryFiltered =
      loweredQuery === undefined
        ? rows
        : rows.filter(
            (row) =>
              row.id.toLowerCase().includes(loweredQuery) ||
              row.description.toLowerCase().includes(loweredQuery),
          );

    const enabledFiltered =
      normalizedEnabled === null
        ? queryFiltered
        : queryFiltered.filter((row) => row.enabled === normalizedEnabled);

    return enabledFiltered.map((row) => ({
      name: row.id,
      type: row.type,
      source: row.source,
      description: row.description,
      hash: row.hash,
      enabled: row.enabled,
    }));
  }

  async getService(serviceName: string): Promise<ServiceDetails> {
    const normalizedServiceName = normalizeServiceName(serviceName);

    let rows: Array<{
      id: string;
      type: ServiceType;
      source: string;
      description: string;
      metadata: ManifestMetadata;
      hash: string;
      enabled: boolean;
      configSchema: Record<string, unknown>;
      secretsSchema: Record<string, unknown>;
    }>;
    try {
      rows = await db
        .select({
          id: manifests.id,
          type: manifests.type,
          source: manifests.source,
          description: manifests.description,
          metadata: manifests.metadata,
          hash: manifests.hash,
          enabled: manifests.enabled,
          configSchema: manifests.configSchema,
          secretsSchema: manifests.secretsSchema,
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
      type: rows[0].type,
      source: rows[0].source,
      description: rows[0].description,
      hash: rows[0].hash,
      enabled: rows[0].enabled,
      configSchema: rows[0].configSchema,
      secretsSchema: rows[0].secretsSchema,
    };
  }

  async listTools(
    serviceName: string,
    query?: string,
    enabled: boolean | null = null,
  ): Promise<ToolListItem[]> {
    const normalizedServiceName = normalizeServiceName(serviceName);

    let serviceRows: Array<{
      id: string;
      enabled: boolean;
      description: string;
    }>;
    try {
      serviceRows = await db
        .select({
          id: manifests.id,
          enabled: manifests.enabled,
          description: manifests.description,
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

    if (serviceRows.length === 0) {
      throw new HttpError(
        404,
        `Manifest not found for service '${normalizedServiceName}'.`,
      );
    }

    let rows: Array<{
      name: string;
      description: string;
      enabled: boolean;
    }>;
    try {
      rows = await db
        .select({
          name: tools.name,
          description: tools.description,
          enabled: tools.enabled,
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

    const serviceEnabled = serviceRows[0].enabled;

    const loweredQuery = normalizeOptionalQuery(query);
    const normalizedEnabled = normalizeListEnabled(enabled);

    const queryFiltered =
      loweredQuery === undefined
        ? rows
        : rows.filter(
            (row) =>
              row.name.toLowerCase().includes(loweredQuery) ||
              row.description.toLowerCase().includes(loweredQuery),
          );

    const mappedRows: ToolListItem[] = queryFiltered.map((row) => ({
      name: row.name,
      description: row.description,
      enabled: serviceEnabled && row.enabled,
    }));

    const enabledFiltered =
      normalizedEnabled === null
        ? mappedRows
        : mappedRows.filter((row) => row.enabled === normalizedEnabled);

    return enabledFiltered;
  }
  async getToolWithServiceInfo(
    serviceName: string,
    toolName: string,
  ): Promise<
    ResolvedToolInvocation & { serviceName: string; serviceDescription: string }
  > {
    const normalizedServiceName = normalizeServiceName(serviceName);
    const resolved = await this.getTool(normalizedServiceName, toolName);
    const service = await this.getService(normalizedServiceName);

    return {
      serviceName: normalizedServiceName,
      serviceDescription: service.description,
      ...resolved,
    };
  }

  async getToolByName(
    toolName: string,
  ): Promise<
    ResolvedToolInvocation & { serviceName: string; serviceDescription: string }
  > {
    const normalizedToolName = normalizeToolName(toolName);

    let rows: Array<{
      serviceName: string;
      serviceDescription: string;
      serviceMetadata: ManifestMetadata;
      serviceEnabled: boolean;
      toolName: string;
      toolDescription: string;
      toolEnabled: boolean;
      toolMetadata: ManifestMetadata;
      inputSchema: JSONSchema;
      outputSchema: JSONSchema;
    }>;

    try {
      rows = await db
        .select({
          serviceName: tools.serviceName,
          serviceDescription: manifests.description,
          serviceMetadata: manifests.metadata,
          serviceEnabled: manifests.enabled,
          toolName: tools.name,
          toolDescription: tools.description,
          toolEnabled: tools.enabled,
          toolMetadata: tools.metadata,
          inputSchema: tools.inputSchema,
          outputSchema: tools.outputSchema,
        })
        .from(tools)
        .innerJoin(manifests, eq(tools.serviceName, manifests.id))
        .where(eq(tools.name, normalizedToolName))
        .orderBy(asc(tools.serviceName))
        .limit(2);
    } catch {
      throw new HttpError(
        500,
        `Failed to lookup tool '${normalizedToolName}'.`,
      );
    }

    if (rows.length === 0) {
      throw new HttpError(404, `Tool '${normalizedToolName}' not found.`);
    }

    if (rows.length > 1) {
      const serviceNames = rows.map((row) => row.serviceName).join(", ");
      throw new HttpError(
        409,
        `Tool '${normalizedToolName}' is ambiguous across services: ${serviceNames}.`,
      );
    }

    const row = rows[0];
    const toolCandidate: unknown = {
      name: row.toolName,
      description: row.toolDescription,
      enabled: row.toolEnabled,
      metadata: row.toolMetadata,
      inputSchema: row.inputSchema,
      outputSchema: row.outputSchema,
    };

    if (!isServiceToolDefinition(toolCandidate)) {
      throw new HttpError(
        500,
        `Stored tool '${row.toolName}' for service '${row.serviceName}' is invalid.`,
      );
    }

    if (!isRecord(row.serviceMetadata)) {
      throw new HttpError(
        500,
        `Stored manifest for service '${row.serviceName}' has invalid metadata.`,
      );
    }

    return {
      serviceName: row.serviceName,
      serviceDescription: row.serviceDescription,
      tool: toolCandidate,
      serviceMetadata: row.serviceMetadata,
      serviceEnabled: row.serviceEnabled,
    };
  }

  async createService(
    source: ServiceInstallRequest,
  ): Promise<{ name: string; type: ServiceType }> {
    const normalizedType = normalizeServiceType(source.type);
    const normalizedSource = normalizeDefinitionFileUrl(source.source);
    const definitionContent =
      await this.downloadRegistryDefinition(normalizedSource);
    const hash = computeContentHash(definitionContent);
    const parsedManifest = await parseRegisteredManifest(
      this.adapter,
      definitionContent,
    );
    const normalizedServiceName = normalizeServiceName(parsedManifest.name);

    try {
      await db.transaction(async (tx) => {
        await tx.insert(manifests).values({
          id: normalizedServiceName,
          type: normalizedType,
          source: normalizedSource,
          description: parsedManifest.description,
          hash,
          enabled: false,
          metadata: parsedManifest.metadata,
          configSchema: parsedManifest.configSchema,
          secretsSchema: parsedManifest.secretsSchema,
        });

        if (parsedManifest.tools.length > 0) {
          await tx.insert(tools).values(
            parsedManifest.tools.map((tool) => ({
              serviceName: normalizedServiceName,
              name: tool.name,
              description: tool.description,
              enabled: true,
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

    return {
      name: normalizedServiceName,
      type: normalizedType,
    };
  }

  async updateService(serviceName: string): Promise<boolean> {
    const normalizedServiceName = normalizeServiceName(serviceName);

    let existingManifestRow: {
      id: string;
      type: ServiceType;
      source: string;
      hash: string;
    } | null = null;

    try {
      const rows = await db
        .select({
          id: manifests.id,
          type: manifests.type,
          source: manifests.source,
          hash: manifests.hash,
        })
        .from(manifests)
        .where(eq(manifests.id, normalizedServiceName))
        .limit(1);

      existingManifestRow = rows[0] ?? null;
    } catch {
      throw new HttpError(
        500,
        `Failed to load manifest for service '${normalizedServiceName}'.`,
      );
    }

    if (!existingManifestRow) {
      throw new HttpError(
        404,
        `Manifest not found for service '${normalizedServiceName}'.`,
      );
    }

    const storedSource = normalizeOptionalSource(existingManifestRow.source);
    if (!storedSource) {
      throw new HttpError(
        409,
        `Service '${normalizedServiceName}' has no stored install source and cannot be updated automatically.`,
      );
    }

    const definitionContent =
      await this.downloadRegistryDefinition(storedSource);
    const hash = computeContentHash(definitionContent);

    if (existingManifestRow.hash === hash) {
      return false;
    }

    const parsedManifest = await parseRegisteredManifest(
      this.adapter,
      definitionContent,
      normalizedServiceName,
    );

    try {
      await db.transaction(async (tx) => {
        const existingTools = await tx
          .select({ name: tools.name, enabled: tools.enabled })
          .from(tools)
          .where(eq(tools.serviceName, normalizedServiceName));

        const existingEnabledByName = new Map(
          existingTools.map((tool) => [tool.name, tool.enabled] as const),
        );

        await tx
          .update(manifests)
          .set({
            type: normalizeServiceType(existingManifestRow.type),
            description: parsedManifest.description,
            hash,
            enabled: false,
            source: storedSource,
            metadata: parsedManifest.metadata,
            configSchema: parsedManifest.configSchema,
            secretsSchema: parsedManifest.secretsSchema,
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
              description: tool.description,
              enabled: existingEnabledByName.get(tool.name) ?? true,
              metadata: tool.metadata,
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema,
            })),
          );
        }
      });
    } catch {
      throw new HttpError(
        500,
        `Failed to update manifest for service '${normalizedServiceName}'.`,
      );
    }

    return true;
  }

  private async downloadRegistryDefinition(fileUrl: string): Promise<string> {
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

    return content;
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

  async discoverTools(
    query: string,
    limit?: number,
    enabled: boolean | null = true,
  ): Promise<ToolDiscoverItem[]> {
    const normalizedQuery = normalizeDiscoverQuery(query);
    const normalizedLimit = normalizeDiscoverLimit(limit);
    const normalizedEnabled = normalizeDiscoverEnabled(enabled);

    let rows: Array<
      Omit<ToolDiscoverItem, "enabled"> & {
        toolEnabled: boolean;
        serviceEnabled: boolean;
      }
    >;
    try {
      rows = await db
        .select({
          serviceName: tools.serviceName,
          name: tools.name,
          description: tools.description,
          toolEnabled: tools.enabled,
          serviceEnabled: manifests.enabled,
        })
        .from(tools)
        .innerJoin(manifests, eq(tools.serviceName, manifests.id))
        .orderBy(asc(tools.serviceName), asc(tools.name));
    } catch {
      throw new HttpError(500, "Failed to discover tools.");
    }

    const mappedRows: ToolDiscoverItem[] = rows.map((row) => ({
      serviceName: row.serviceName,
      name: row.name,
      description: row.description,
      enabled: row.serviceEnabled && row.toolEnabled,
    }));

    const enabledFiltered =
      normalizedEnabled === null
        ? mappedRows
        : mappedRows.filter((row) => row.enabled === normalizedEnabled);

    if (normalizedQuery.length === 0) {
      return applyDiscoverLimit(enabledFiltered, normalizedLimit);
    }

    const loweredQuery = normalizedQuery.toLowerCase();

    const filtered = enabledFiltered.filter(
      (row) =>
        row.name.toLowerCase().includes(loweredQuery) ||
        row.description.toLowerCase().includes(loweredQuery) ||
        row.serviceName.toLowerCase().includes(loweredQuery),
    );

    return applyDiscoverLimit(filtered, normalizedLimit);
  }

  async discoverServices(
    query: string,
    limit?: number,
    enabled: boolean | null = true,
  ): Promise<ServiceListItem[]> {
    const normalizedQuery = normalizeDiscoverQuery(query);
    const normalizedLimit = normalizeDiscoverLimit(limit);
    const normalizedEnabled = normalizeDiscoverEnabled(enabled);
    const services = await this.listServices();
    const enabledFiltered =
      normalizedEnabled === null
        ? services
        : services.filter((service) => service.enabled === normalizedEnabled);

    if (normalizedQuery.length === 0) {
      return applyDiscoverLimit(enabledFiltered, normalizedLimit);
    }

    const loweredQuery = normalizedQuery.toLowerCase();

    const filtered = enabledFiltered.filter(
      (service) =>
        service.name.toLowerCase().includes(loweredQuery) ||
        service.description.toLowerCase().includes(loweredQuery),
    );

    return applyDiscoverLimit(filtered, normalizedLimit);
  }

  async getTool(
    serviceName: string,
    toolName: string,
  ): Promise<ResolvedToolInvocation> {
    const normalizedServiceName = normalizeServiceName(serviceName);
    const normalizedToolName = normalizeToolName(toolName);

    let serviceManifest: {
      metadata: ManifestMetadata;
      enabled: boolean;
    } | null;
    try {
      serviceManifest = await this.loadServiceMetadata(normalizedServiceName);
    } catch {
      throw new HttpError(
        500,
        `Failed to load manifest for service '${normalizedServiceName}'.`,
      );
    }

    if (!serviceManifest) {
      throw new HttpError(
        404,
        `Manifest not found for service '${normalizedServiceName}'.`,
      );
    }

    let tool: ServiceToolDefinition | null;
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
      serviceMetadata: serviceManifest.metadata,
      serviceEnabled: serviceManifest.enabled,
    };
  }

  async setServiceEnabled(
    serviceName: string,
    enabled: boolean,
  ): Promise<void> {
    const normalizedServiceName = normalizeServiceName(serviceName);
    const normalizedEnabled = normalizeEnabled(enabled);

    if (normalizedEnabled) {
      const config = await this.getServiceConfig(normalizedServiceName);
      const schema = await this.getServiceConfigSchema(normalizedServiceName);

      if (!isNullOnlySchema(schema)) {
        applyJsonSchemaDefaults(
          schema,
          config,
          `Invalid configuration for service '${normalizedServiceName}'.`,
        );
      }

      const secrets = await this.loadServiceSecrets(normalizedServiceName);
      const secretsSchema = await this.getServiceSecretsSchema(
        normalizedServiceName,
      );

      if (!isNullOnlySchema(secretsSchema)) {
        applyJsonSchemaDefaults(
          secretsSchema,
          secrets,
          `Invalid secrets for service '${normalizedServiceName}'.`,
        );
      }
    }

    let updatedRows: Array<{ id: string }>;
    try {
      updatedRows = await db
        .update(manifests)
        .set({ enabled: normalizedEnabled })
        .where(eq(manifests.id, normalizedServiceName))
        .returning({ id: manifests.id });
    } catch {
      throw new HttpError(
        500,
        `Failed to update enabled status for service '${normalizedServiceName}'.`,
      );
    }

    if (updatedRows.length === 0) {
      throw new HttpError(
        404,
        `Manifest not found for service '${normalizedServiceName}'.`,
      );
    }
  }

  async setToolEnabled(
    serviceName: string,
    toolName: string,
    enabled: boolean,
  ): Promise<void> {
    const normalizedServiceName = normalizeServiceName(serviceName);
    const normalizedToolName = normalizeToolName(toolName);
    const normalizedEnabled = normalizeEnabled(enabled);

    let updatedRows: Array<{ serviceName: string; name: string }>;
    try {
      updatedRows = await db
        .update(tools)
        .set({ enabled: normalizedEnabled })
        .where(
          and(
            eq(tools.serviceName, normalizedServiceName),
            eq(tools.name, normalizedToolName),
          ),
        )
        .returning({ serviceName: tools.serviceName, name: tools.name });
    } catch {
      throw new HttpError(
        500,
        `Failed to update enabled status for tool '${normalizedToolName}' in service '${normalizedServiceName}'.`,
      );
    }

    if (updatedRows.length === 0) {
      throw new HttpError(
        404,
        `Tool '${normalizedToolName}' not found in manifest for service '${normalizedServiceName}'.`,
      );
    }
  }

  async getServiceConfig(
    serviceName: string,
  ): Promise<Record<string, unknown>> {
    const normalizedServiceName = normalizeServiceName(serviceName);

    let rows: Array<{ config: Record<string, unknown> }>;
    try {
      rows = await db
        .select({ config: configurations.config })
        .from(configurations)
        .where(eq(configurations.serviceName, normalizedServiceName))
        .limit(1);
    } catch {
      throw new HttpError(
        500,
        `Failed to load configuration for service '${normalizedServiceName}'.`,
      );
    }

    const config = rows[0]?.config;
    if (config && typeof config === "object" && !Array.isArray(config)) {
      return config;
    }

    return {};
  }

  async getServiceConfigSchema(
    serviceName: string,
  ): Promise<Record<string, unknown>> {
    const normalizedServiceName = normalizeServiceName(serviceName);

    let rows: Array<{ configSchema: Record<string, unknown> }>;
    try {
      rows = await db
        .select({ configSchema: manifests.configSchema })
        .from(manifests)
        .where(eq(manifests.id, normalizedServiceName))
        .limit(1);
    } catch {
      throw new HttpError(
        500,
        `Failed to load configuration schema for service '${normalizedServiceName}'.`,
      );
    }

    if (rows.length === 0) {
      throw new HttpError(404, `Service '${normalizedServiceName}' not found.`);
    }

    return rows[0].configSchema;
  }

  async getServiceSecretsSchema(
    serviceName: string,
  ): Promise<Record<string, unknown>> {
    const normalizedServiceName = normalizeServiceName(serviceName);

    let rows: Array<{ secretsSchema: Record<string, unknown> }>;
    try {
      rows = await db
        .select({ secretsSchema: manifests.secretsSchema })
        .from(manifests)
        .where(eq(manifests.id, normalizedServiceName))
        .limit(1);
    } catch {
      throw new HttpError(
        500,
        `Failed to load secrets schema for service '${normalizedServiceName}'.`,
      );
    }

    if (rows.length === 0) {
      throw new HttpError(404, `Service '${normalizedServiceName}' not found.`);
    }

    return rows[0].secretsSchema;
  }

  async patchServiceConfig(
    serviceName: string,
    patch: Operation[],
  ): Promise<Record<string, unknown>> {
    const normalizedServiceName = normalizeServiceName(serviceName);

    const current = await this.getServiceConfig(normalizedServiceName);
    const schema = await this.getServiceConfigSchema(normalizedServiceName);

    let updated: Record<string, unknown>;
    try {
      const result = applyPatch(current, patch, true, false);
      updated = result.newDocument as Record<string, unknown>;
    } catch (error) {
      throw new HttpError(
        400,
        error instanceof Error ? error.message : "Invalid JSON Patch payload.",
      );
    }

    validateJsonSchema(
      schema,
      updated,
      `Invalid configuration for service '${normalizedServiceName}'.`,
    );

    const normalizedConfig = isNullOnlySchema(schema)
      ? updated
      : applyJsonSchemaDefaults(
          schema,
          updated,
          `Invalid configuration for service '${normalizedServiceName}'.`,
        );

    const updatedAt = Date.now();

    try {
      await db
        .insert(configurations)
        .values({
          serviceName: normalizedServiceName,
          config: normalizedConfig,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: configurations.serviceName,
          set: { config: normalizedConfig, updatedAt },
        });
    } catch {
      throw new HttpError(
        500,
        `Failed to persist configuration for service '${normalizedServiceName}'.`,
      );
    }

    return normalizedConfig;
  }

  async patchServiceSecrets(
    serviceName: string,
    patch: Operation[],
  ): Promise<Record<string, unknown>> {
    const normalizedServiceName = normalizeServiceName(serviceName);

    const schema = await this.getServiceSecretsSchema(normalizedServiceName);

    const current = await this.loadServiceSecrets(normalizedServiceName);

    let updated: Record<string, unknown>;
    try {
      const result = applyPatch(current, patch, true, false);
      updated = normalizeSecrets(
        result.newDocument,
        "Secrets payload must be a JSON object.",
      );
    } catch (error) {
      throw new HttpError(
        400,
        error instanceof Error ? error.message : "Invalid JSON Patch payload.",
      );
    }

    validateJsonSchema(
      schema,
      updated,
      `Invalid secrets for service '${normalizedServiceName}'.`,
    );

    const normalizedSecrets = isNullOnlySchema(schema)
      ? updated
      : applyJsonSchemaDefaults(
          schema,
          updated,
          `Invalid secrets for service '${normalizedServiceName}'.`,
        );

    const encrypted = encryptSecrets(normalizedSecrets);
    const updatedAt = Date.now();

    try {
      await db
        .insert(secrets)
        .values({
          serviceName: normalizedServiceName,
          payload: encrypted,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: secrets.serviceName,
          set: { payload: encrypted, updatedAt },
        });
    } catch {
      throw new HttpError(
        500,
        `Failed to persist secrets for service '${normalizedServiceName}'.`,
      );
    }

    logger.info(
      {
        serviceName: normalizedServiceName,
        secretKeyCount: Object.keys(normalizedSecrets).length,
      },
      "Service secrets updated",
    );

    return normalizedSecrets;
  }

  async getAllServiceManifests(): Promise<ServiceManifestDefinition[]> {
    let serviceRows: Array<{
      id: string;
      description: string;
      enabled: boolean;
      configSchema: Record<string, unknown>;
      secretsSchema: Record<string, unknown>;
      metadata: ManifestMetadata;
    }>;

    try {
      serviceRows = await db
        .select({
          id: manifests.id,
          description: manifests.description,
          enabled: manifests.enabled,
          configSchema: manifests.configSchema,
          secretsSchema: manifests.secretsSchema,
          metadata: manifests.metadata,
        })
        .from(manifests)
        .orderBy(asc(manifests.id));
    } catch {
      throw new HttpError(500, "Failed to load service manifests.");
    }

    let toolRows: Array<{
      serviceName: string;
      name: string;
      description: string;
      enabled: boolean;
      metadata: ManifestMetadata;
      inputSchema: JSONSchema;
      outputSchema: JSONSchema;
    }>;

    try {
      toolRows = await db
        .select({
          serviceName: tools.serviceName,
          name: tools.name,
          description: tools.description,
          enabled: tools.enabled,
          metadata: tools.metadata,
          inputSchema: tools.inputSchema,
          outputSchema: tools.outputSchema,
        })
        .from(tools)
        .orderBy(asc(tools.serviceName), asc(tools.name));
    } catch {
      throw new HttpError(500, "Failed to load service tools.");
    }

    const toolsByServiceName = new Map<string, ServiceToolDefinition[]>();

    for (const row of toolRows) {
      const toolCandidate: unknown = {
        name: row.name,
        description: row.description,
        enabled: row.enabled,
        metadata: row.metadata,
        inputSchema: row.inputSchema,
        outputSchema: row.outputSchema,
      };

      if (!isServiceToolDefinition(toolCandidate)) {
        throw new HttpError(
          500,
          `Stored tool '${row.name}' for service '${row.serviceName}' is invalid.`,
        );
      }

      const current = toolsByServiceName.get(row.serviceName) ?? [];
      current.push(toolCandidate);
      toolsByServiceName.set(row.serviceName, current);
    }

    return serviceRows.map((service) => {
      if (!isRecord(service.metadata)) {
        throw new HttpError(
          500,
          `Stored manifest for service '${service.id}' has invalid metadata.`,
        );
      }

      return {
        name: service.id,
        description: service.description,
        enabled: service.enabled,
        configSchema: service.configSchema,
        secretsSchema: service.secretsSchema,
        metadata: service.metadata,
        tools: toolsByServiceName.get(service.id) ?? [],
      };
    });
  }

  private async loadServiceSecrets(
    serviceName: string,
  ): Promise<Record<string, unknown>> {
    let rows: Array<{ payload: EncryptedSecretsPayload }>;
    try {
      rows = await db
        .select({ payload: secrets.payload })
        .from(secrets)
        .where(eq(secrets.serviceName, serviceName))
        .limit(1);
    } catch {
      throw new HttpError(
        500,
        `Failed to load secrets for service '${serviceName}'.`,
      );
    }

    const payload = rows[0]?.payload;
    if (!payload) {
      return {};
    }

    return decryptSecrets(normalizeEncryptedSecretsPayload(payload));
  }

  async getAllStagedServiceManifests(): Promise<StagedServiceEntry[]> {
    let serviceRows: Array<{ id: string }>;

    try {
      serviceRows = await db
        .select({ id: manifests.id })
        .from(manifests)
        .orderBy(asc(manifests.id));
    } catch {
      throw new HttpError(500, "Failed to load service manifests for staging.");
    }

    let toolRows: Array<{
      serviceName: string;
      name: string;
    }>;

    try {
      toolRows = await db
        .select({
          serviceName: tools.serviceName,
          name: tools.name,
        })
        .from(tools)
        .orderBy(asc(tools.serviceName), asc(tools.name));
    } catch {
      throw new HttpError(500, "Failed to load service tools for staging.");
    }

    const toolsByServiceName = new Map<string, Array<{ name: string }>>();

    for (const row of toolRows) {
      const current = toolsByServiceName.get(row.serviceName) ?? [];
      current.push({ name: row.name });
      toolsByServiceName.set(row.serviceName, current);
    }

    return serviceRows.map((service) => ({
      name: service.id,
      tools: toolsByServiceName.get(service.id) ?? [],
    }));
  }
}

async function parseRegisteredManifest(
  adapter: AdapterModule,
  definitionContent: string,
  expectedServiceName?: string,
): Promise<ServiceManifestDefinition> {
  try {
    const parsedManifest = await adapter.register(definitionContent);

    if (
      expectedServiceName !== undefined &&
      parsedManifest.name !== expectedServiceName
    ) {
      throw new HttpError(
        400,
        `Manifest name '${parsedManifest.name}' must match service name '${expectedServiceName}'.`,
      );
    }

    return parsedManifest satisfies ServiceManifestDefinition;
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

function normalizeServiceName(serviceName: string): string {
  const parsed = z
    .string({ error: "Service name must not be empty." })
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, {
      error: "Service name must not be empty.",
    })
    .refine((value) => /^[a-zA-Z0-9._-]+$/.test(value), {
      error:
        "Service name may only contain letters, numbers, dot, underscore, and hyphen.",
    })
    .safeParse(serviceName);

  if (!parsed.success) {
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message ?? "Service name must not be empty.",
    );
  }

  return parsed.data;
}

function normalizeOptionalQuery(query: string | undefined): string | undefined {
  const normalized = query?.trim().toLowerCase();

  if (!normalized) {
    return undefined;
  }

  return normalized;
}

function normalizeToolName(toolName: string): string {
  const parsed = z
    .string({ error: "Tool name must not be empty." })
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, {
      error: "Tool name must not be empty.",
    })
    .safeParse(toolName);

  if (!parsed.success) {
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message ?? "Tool name must not be empty.",
    );
  }

  return parsed.data;
}

function normalizeDiscoverQuery(query: string): string {
  const parsed = z
    .string({ error: "Field 'query' must be a string." })
    .transform((value) => value.trim())
    .safeParse(query);

  if (!parsed.success) {
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message ?? "Field 'query' must be a string.",
    );
  }

  return parsed.data;
}

function normalizeDiscoverLimit(limit: unknown): number | undefined {
  if (limit === undefined) {
    return undefined;
  }

  const parsed = z
    .number({ error: "Field 'limit' must be a positive integer." })
    .int({ error: "Field 'limit' must be a positive integer." })
    .positive({ error: "Field 'limit' must be a positive integer." })
    .safeParse(limit);

  if (!parsed.success) {
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message ??
        "Field 'limit' must be a positive integer.",
    );
  }

  return parsed.data;
}

function normalizeDiscoverEnabled(enabled: unknown): boolean | null {
  if (enabled === undefined) {
    return true;
  }

  const parsed = z
    .boolean({ error: "Field 'enabled' must be a boolean or null." })
    .nullable()
    .safeParse(enabled);

  if (!parsed.success) {
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message ??
        "Field 'enabled' must be a boolean or null.",
    );
  }

  return parsed.data;
}

function normalizeListEnabled(enabled: unknown): boolean | null {
  if (enabled === undefined) {
    return null;
  }

  const parsed = z
    .boolean({ error: "Field 'enabled' must be a boolean or null." })
    .nullable()
    .safeParse(enabled);

  if (!parsed.success) {
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message ??
        "Field 'enabled' must be a boolean or null.",
    );
  }

  return parsed.data;
}

function applyDiscoverLimit<T>(items: T[], limit: number | undefined): T[] {
  if (limit === undefined) {
    return items;
  }

  return items.slice(0, limit);
}

function normalizeServiceType(type: string): ServiceType {
  const parsed = z
    .string({ error: "Field 'type' must not be empty." })
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, {
      error: "Field 'type' must not be empty.",
    })
    .safeParse(type);

  if (!parsed.success) {
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message ?? "Field 'type' must not be empty.",
    );
  }

  return parsed.data;
}

function normalizeOptionalSource(source: string): string | null {
  const parsed = z.string().safeParse(source);

  if (!parsed.success) {
    return null;
  }

  const normalized = parsed.data.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeDefinitionFileUrl(fileUrl: string): string {
  const normalizedParse = z
    .string({ error: "Field 'metadata.file_url' must be a string." })
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, {
      error: "Field 'metadata.file_url' must not be empty.",
    })
    .safeParse(fileUrl);

  if (!normalizedParse.success) {
    throw new HttpError(
      400,
      normalizedParse.error.issues[0]?.message ??
        "Field 'metadata.file_url' must be a string.",
    );
  }

  const normalized = normalizedParse.data;

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new HttpError(400, "Field 'metadata.file_url' must be a valid URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(
      400,
      "Field 'metadata.file_url' must use the http or https protocol.",
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

  if (!ipaddr.isValid(normalizedHost)) {
    return;
  }

  ipaddr.process(normalizedHost);
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

async function loadServiceMetadataByServiceName(
  serviceName: string,
): Promise<{ metadata: ManifestMetadata; enabled: boolean } | null> {
  const rows = await db
    .select({ metadata: manifests.metadata, enabled: manifests.enabled })
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

  return {
    metadata,
    enabled: rows[0].enabled,
  };
}

async function loadToolByServiceAndToolName(
  serviceName: string,
  toolName: string,
): Promise<ServiceToolDefinition | null> {
  const rows = await db
    .select({
      name: tools.name,
      description: tools.description,
      enabled: tools.enabled,
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
  if (!isServiceToolDefinition(tool)) {
    throw new HttpError(
      500,
      `Stored tool '${toolName}' for service '${serviceName}' is invalid.`,
    );
  }

  return tool;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return metadataSchema.safeParse(value).success;
}

function isServiceToolDefinition(
  value: unknown,
): value is ServiceToolDefinition {
  return persistedToolSchema.safeParse(value).success;
}

function normalizeEncryptedSecretsPayload(
  payload: unknown,
): EncryptedSecretsPayload {
  const parsed = encryptedSecretsSchema.safeParse(payload);

  if (!parsed.success) {
    throw new HttpError(500, "Stored secrets payload is malformed.");
  }

  return parsed.data;
}

function normalizeEnabled(enabled: unknown): boolean {
  const parsed = z
    .boolean({ error: "Field 'enabled' must be a boolean." })
    .safeParse(enabled);

  if (!parsed.success) {
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message ?? "Field 'enabled' must be a boolean.",
    );
  }

  return parsed.data;
}

function isNullOnlySchema(schema: Record<string, unknown>): boolean {
  const type = schema.type;

  if (type === "null") {
    return true;
  }

  if (Array.isArray(type) && type.length === 1 && type[0] === "null") {
    return true;
  }

  return false;
}
