import type {
  JSONSchema,
  ServiceDefinition,
  ServiceState,
  ToolDocsInput,
} from "@cyrnel/sdk";
import { and, asc, eq, getTableColumns, like, or, sql } from "drizzle-orm";
import jsonpatch from "fast-json-patch";

import { z } from "zod";

import { db } from "@/db/client";
import {
  modules as modulesTable,
  serviceConfigurations,
  serviceSecrets,
  services,
  tools,
} from "@/db/schema";
import { logger } from "@/logger";
import { HttpError } from "@/models/error.model";
import type { GenerateDefinitionInput } from "@/models/modules.model";
import type {
  DirectInstallServiceInput,
  GetServiceDefinitionResult,
  GetToolInput,
  GetToolsResult,
  ListServiceDefinitionResult,
  ListServicesInput,
  ListToolsInput,
  ListToolsResult,
  PatchInput,
  RegistryInstallServiceInput,
  SecretsPresence,
  ServiceConfigView,
  SetServiceEnabledInput,
  SetToolEnablesInput,
} from "@/models/services.model";
import type { ToolSearchIndex } from "@/services/search.service";
import { downloadText } from "@/utils/download.util";
import { computeContentHash } from "@/utils/hash.util";
import type { IconColumns } from "@/utils/icon.util";
import { fetchAndValidateIcon, resolveIconUpdate } from "@/utils/icon.util";
import {
  collectOutdatedPaths,
  filterPayloadToSchema,
  isNullOnlySchema,
  mergeStaleKeys,
  newOutdatedPaths,
  pathExists,
} from "@/utils/schema.util";
import {
  collectPresentPaths,
  decryptAndMaybeReEncrypt,
  encryptSecrets,
} from "@/utils/secrets.util";
import {
  applyJsonSchemaDefaults,
  normalizeSummary,
} from "@/utils/validation.util";

const DEFINITION_DOWNLOAD_MAX_BYTES = 30 * 1024 * 1024;
const IDENTIFIER_SCHEMA = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
const SEARCH_DEFAULT_LIMIT = 50;

export interface AdapterController {
  generateDefinition(
    input: GenerateDefinitionInput,
  ): Promise<ServiceDefinition>;
  hydrateService(adapterId: string, state: ServiceState): Promise<void>;
  dehydrateService(adapterId: string, serviceId: string): Promise<void>;
  generateToolDocs(input: ToolDocsInput): Promise<string>;
}

const encryptedSecretsSchema = z.object({
  kid: z.string().optional(),
  alg: z.literal("aes-256-gcm"),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

export class ServicesService {
  constructor(
    private readonly controller: AdapterController,
    private readonly search?: ToolSearchIndex,
  ) {}

  async listServices(
    input?: ListServicesInput,
  ): Promise<ListServiceDefinitionResult[]> {
    const normalizedQuery = input?.query?.trim();

    try {
      const {
        configSchema,
        secretsSchema,
        adapterDomain,
        hash,
        source,
        definitionContent,
        iconData,
        iconMime,
        ...serviceColumns
      } = getTableColumns(services);

      const query = db
        .select({
          ...serviceColumns,
          iconHash: services.iconHash,
          effectivelyEnabled: sql<boolean>`${services.enabled} AND ${modulesTable.enabled} AND NOT ${modulesTable.missing}`,
        })
        .from(services)
        .leftJoin(modulesTable, eq(services.adapter, modulesTable.id))
        .where(
          and(
            input?.enabled !== undefined
              ? eq(services.enabled, input.enabled)
              : undefined,
            input?.adapter !== undefined
              ? eq(services.adapter, input.adapter)
              : undefined,
            input?.stale !== undefined
              ? eq(services.stale, input.stale)
              : undefined,
            normalizedQuery
              ? or(
                  like(services.id, `%${normalizedQuery}%`),
                  like(services.name, `%${normalizedQuery}%`),
                  like(services.summary, `%${normalizedQuery}%`),
                  like(services.description, `%${normalizedQuery}%`),
                )
              : undefined,
          ),
        )
        .orderBy(asc(services.id));

      const rows = await (input?.limit !== undefined
        ? query.limit(Number(input.limit))
        : query);

      return rows.map(({ iconHash, ...row }) => ({
        ...row,
        hasIcon: iconHash !== null,
      }));
    } catch {
      throw new HttpError(500, "Failed to list services.");
    }
  }

  async getService(id: string): Promise<GetServiceDefinitionResult> {
    const {
      adapterDomain,
      definitionContent,
      iconData,
      iconMime,
      ...serviceColumns
    } = getTableColumns(services);
    const [row] = await db
      .select({
        ...serviceColumns,
        iconHash: services.iconHash,
        effectivelyEnabled: sql<boolean>`${services.enabled} AND ${modulesTable.enabled} AND NOT ${modulesTable.missing}`,
      })
      .from(services)
      .leftJoin(modulesTable, eq(services.adapter, modulesTable.id))
      .where(eq(services.id, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, `Failed to load service '${id}'.`);
      });

    if (!row) throw new HttpError(404, `Service '${id}' not found.`);
    const { iconHash, ...rest } = row;
    return { ...rest, hasIcon: iconHash !== null };
  }

  async getServiceIcon(
    id: string,
  ): Promise<{ data: Buffer; mime: string; hash: string } | null> {
    const [row] = await db
      .select({
        iconData: services.iconData,
        iconMime: services.iconMime,
        iconHash: services.iconHash,
      })
      .from(services)
      .where(eq(services.id, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, `Failed to load service '${id}'.`);
      });

    if (!row) throw new HttpError(404, `Service '${id}' not found.`);
    if (!row.iconData || !row.iconMime || !row.iconHash) return null;
    return { data: row.iconData, mime: row.iconMime, hash: row.iconHash };
  }

  async listTools(input: ListToolsInput): Promise<ListToolsResult[]> {
    let serviceEnabled: boolean | undefined;

    if (input.serviceId) {
      const [service] = await db
        .select({ enabled: services.enabled })
        .from(services)
        .where(eq(services.id, input.serviceId))
        .limit(1)
        .catch(() => {
          throw new HttpError(
            500,
            `Failed to load service '${input.serviceId}'.`,
          );
        });

      if (!service)
        throw new HttpError(404, `Service '${input.serviceId}' not found.`);
      serviceEnabled = service.enabled;
    }

    const normalizedQuery = input.query?.trim();

    if (normalizedQuery && this.search) {
      try {
        const hits = await this.search.searchTools(normalizedQuery, {
          serviceId: input.serviceId,
          enabled: input.enabled,
          limit: input.limit ?? SEARCH_DEFAULT_LIMIT,
        });
        return hits.map((hit) => ({
          serviceId: hit.serviceId,
          id: hit.toolId,
          name: hit.name,
          summary: hit.summary,
          description: hit.description,
          enabled: hit.enabled,
          score: hit.score,
          matchType: hit.matchType,
          ...(hit.ftsRank !== undefined ? { ftsRank: hit.ftsRank } : {}),
          ...(hit.vectorRank !== undefined
            ? { vectorRank: hit.vectorRank }
            : {}),
          effectivelyEnabled: (serviceEnabled ?? true) && hit.enabled,
        }));
      } catch (err) {
        logger.warn(
          {
            event: "search-index-fallback",
            err,
            serviceId: input.serviceId,
            query: normalizedQuery,
          },
          "Search index lookup failed; falling back to LIKE query",
        );
      }
    }

    const query = db
      .select({
        serviceId: tools.serviceId,
        id: tools.id,
        name: tools.name,
        summary: tools.summary,
        description: tools.description,
        enabled: tools.enabled,
      })
      .from(tools)
      .where(
        and(
          input.serviceId ? eq(tools.serviceId, input.serviceId) : undefined,
          input.enabled !== undefined
            ? eq(tools.enabled, input.enabled)
            : undefined,
          normalizedQuery
            ? or(
                like(tools.name, `%${normalizedQuery}%`),
                like(tools.summary, `%${normalizedQuery}%`),
                like(tools.description, `%${normalizedQuery}%`),
              )
            : undefined,
        ),
      )
      .orderBy(asc(tools.name));

    const rows = await (input.limit !== undefined
      ? query.limit(input.limit)
      : query
    ).catch(() => {
      throw new HttpError(500, `Failed to load tools.`);
    });

    return rows.map((row) => ({
      ...row,
      effectivelyEnabled: (serviceEnabled ?? true) && row.enabled,
    }));
  }

  async getTool(input: GetToolInput): Promise<GetToolsResult> {
    const { serviceId, adapterDomain, ...toolColumns } = getTableColumns(tools);
    const [tool] = await db
      .select({
        ...toolColumns,
        serviceEnabled: services.enabled,
      })
      .from(tools)
      .innerJoin(services, eq(tools.serviceId, services.id))
      .where(
        and(eq(tools.serviceId, input.serviceId), eq(tools.id, input.toolId)),
      )
      .limit(1)
      .catch(() => {
        throw new HttpError(
          500,
          `Failed to load tool '${input.toolId}' for service '${input.serviceId}'.`,
        );
      });

    if (!tool)
      throw new HttpError(
        404,
        `Tool '${input.toolId}' not found for service '${input.serviceId}'.`,
      );

    return {
      ...tool,
      effectivelyEnabled: tool.enabled && tool.serviceEnabled,
    };
  }

  async getToolDocs(input: GetToolInput): Promise<string> {
    const [tool] = await db
      .select({
        summary: tools.summary,
        description: tools.description,
        inputSchema: tools.inputSchema,
        outputSchema: tools.outputSchema,
      })
      .from(tools)
      .where(
        and(eq(tools.serviceId, input.serviceId), eq(tools.id, input.toolId)),
      )
      .limit(1)
      .catch(() => {
        throw new HttpError(
          500,
          `Failed to load tool '${input.toolId}' for service '${input.serviceId}'.`,
        );
      });

    if (!tool)
      throw new HttpError(
        404,
        `Tool '${input.toolId}' not found for service '${input.serviceId}'.`,
      );

    const docsInput: ToolDocsInput = {
      serviceId: input.serviceId,
      toolId: input.toolId,
      summary: tool.summary,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    };

    return this.controller.generateToolDocs(docsInput);
  }

  async createServiceDirect(input: DirectInstallServiceInput): Promise<void> {
    if (!IDENTIFIER_SCHEMA.safeParse(input.id).success) {
      throw new HttpError(
        400,
        `Service id '${input.id}' must be a valid TypeScript identifier.`,
      );
    }

    const definitionContent = await this.downloadDefinition(input.url);
    const hash = computeContentHash(definitionContent);
    const generatedDefinition = await this.controller.generateDefinition({
      definition: definitionContent,
      adapter: input.adapter,
    });

    for (const tool of generatedDefinition.tools) {
      if (!IDENTIFIER_SCHEMA.safeParse(tool.id).success) {
        throw new HttpError(
          400,
          `Tool id '${tool.id}' must be a valid TypeScript identifier.`,
        );
      }
    }

    try {
      await db.transaction(async (tx) => {
        await tx.insert(services).values({
          ...generatedDefinition,
          summary: normalizeSummary(generatedDefinition.summary),
          id: input.id,
          hash,
          version: "0.0.0",
          source: "",
          adapter: input.adapter,
          enabled: false,
          definitionContent,
        });
        await tx.insert(tools).values(
          generatedDefinition.tools.map((tool) => ({
            ...tool,
            summary: normalizeSummary(tool.summary),
            serviceId: input.id,
            enabled: true,
          })),
        );
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new HttpError(409, `Service '${input.id}' already exists.`);
      }
      throw new HttpError(500, `Failed to create service '${input.id}'.`);
    }

    await this.reindexServiceSearch(input.id);
  }

  async createServiceFromRegistry(
    input: RegistryInstallServiceInput,
  ): Promise<string> {
    const { resolveServiceRegistry } = await import("@/utils/registry.util");
    const registry = await resolveServiceRegistry(input.source, input.version);

    const effectiveId = input.id ?? registry.id;
    const effectiveAdapter = input.adapter ?? registry.adapter;

    if (!effectiveId) {
      throw new HttpError(
        400,
        "Service id must be provided either in the request body or by the registry.",
      );
    }

    if (!effectiveAdapter) {
      throw new HttpError(
        400,
        "Adapter must be provided either in the request body or by the registry.",
      );
    }

    if (!IDENTIFIER_SCHEMA.safeParse(effectiveId).success) {
      throw new HttpError(
        400,
        `Service id '${effectiveId}' must be a valid TypeScript identifier.`,
      );
    }

    const [definitionContent, icon] = await Promise.all([
      this.downloadDefinition(registry.downloadUrl),
      registry.icon
        ? fetchAndValidateIcon(registry.icon, "service", effectiveId)
        : Promise.resolve(null),
    ]);
    const contentHash = computeContentHash(definitionContent);

    if (registry.hash && contentHash !== registry.hash) {
      throw new HttpError(
        400,
        "Definition content hash does not match registry metadata hash.",
      );
    }

    const generatedDefinition = await this.controller.generateDefinition({
      definition: definitionContent,
      adapter: effectiveAdapter,
    });

    for (const tool of generatedDefinition.tools) {
      if (!IDENTIFIER_SCHEMA.safeParse(tool.id).success) {
        throw new HttpError(
          400,
          `Tool id '${tool.id}' must be a valid TypeScript identifier.`,
        );
      }
    }

    try {
      await db.transaction(async (tx) => {
        await tx.insert(services).values({
          ...generatedDefinition,
          summary: normalizeSummary(generatedDefinition.summary),
          id: effectiveId,
          hash: contentHash,
          version: registry.version,
          source: input.source,
          adapter: effectiveAdapter,
          enabled: false,
          definitionContent,
          iconData: icon?.data ?? null,
          iconMime: icon?.mime ?? null,
          iconHash: icon?.hash ?? null,
        });
        await tx.insert(tools).values(
          generatedDefinition.tools.map((tool) => ({
            ...tool,
            summary: normalizeSummary(tool.summary),
            serviceId: effectiveId,
            enabled: true,
          })),
        );
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new HttpError(409, `Service '${effectiveId}' already exists.`);
      }
      throw new HttpError(500, `Failed to create service '${effectiveId}'.`);
    }

    await this.reindexServiceSearch(effectiveId);

    return effectiveId;
  }

  async syncService(id: string): Promise<void> {
    const [service] = await db
      .select({
        adapter: services.adapter,
        definitionContent: services.definitionContent,
      })
      .from(services)
      .where(eq(services.id, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, `Failed to load service '${id}'.`);
      });

    if (!service) throw new HttpError(404, `Service '${id}' not found.`);
    if (!service.definitionContent)
      throw new HttpError(
        409,
        `Service '${id}' has no stored definition content and cannot be synced.`,
      );

    const generatedDefinition = await this.controller.generateDefinition({
      definition: service.definitionContent,
      adapter: service.adapter,
    });

    for (const tool of generatedDefinition.tools) {
      if (!IDENTIFIER_SCHEMA.safeParse(tool.id).success) {
        throw new HttpError(
          400,
          `Tool id '${tool.id}' must be a valid TypeScript identifier.`,
        );
      }
    }

    try {
      await db.transaction(async (tx) => {
        const existingTools = await tx
          .select({ id: tools.id, enabled: tools.enabled })
          .from(tools)
          .where(eq(tools.serviceId, id));

        const enabledMap = new Map(existingTools.map((t) => [t.id, t.enabled]));

        await tx
          .update(services)
          .set({
            ...generatedDefinition,
            summary: normalizeSummary(generatedDefinition.summary),
            enabled: false,
            stale: false,
          })
          .where(eq(services.id, id));

        await tx.delete(tools).where(eq(tools.serviceId, id));

        if (generatedDefinition.tools.length) {
          await tx.insert(tools).values(
            generatedDefinition.tools.map((tool) => ({
              ...tool,
              summary: normalizeSummary(tool.summary),
              serviceId: id,
              enabled: enabledMap.get(tool.id) ?? false,
            })),
          );
        }
      });
    } catch {
      throw new HttpError(500, `Failed to sync service '${id}'.`);
    }

    await this.reindexServiceSearch(id);

    try {
      await this.controller.dehydrateService(service.adapter, id);
    } catch (err) {
      logger.warn(
        {
          event: "dehydrate-failed-sync",
          err,
          adapterId: service.adapter,
          serviceId: id,
        },
        "Failed to dehydrate service on sync",
      );
    }
  }

  async updateService(id: string): Promise<void> {
    const [service] = await db
      .select({
        adapter: services.adapter,
        source: services.source,
        hash: services.hash,
        version: services.version,
        iconHash: services.iconHash,
      })
      .from(services)
      .where(eq(services.id, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, `Failed to load service '${id}'.`);
      });

    if (!service) throw new HttpError(404, `Service '${id}' not found.`);
    if (!service.source)
      throw new HttpError(
        409,
        `Service '${id}' has no stored install source and cannot be updated automatically. Only registry-installed services can be updated.`,
      );

    let registry: {
      version: string;
      downloadUrl: string;
      hash?: string;
      icon?: { url: string; hash: string };
    };
    try {
      const { resolveServiceRegistry } = await import("@/utils/registry.util");
      registry = await resolveServiceRegistry(service.source);
    } catch (err) {
      if (err instanceof HttpError) {
        throw new HttpError(
          err.statusCode,
          `Service '${id}' registry source error: ${err.message}. Use PATCH to update with a direct download URL, or reinstall from a registry first.`,
        );
      }
      throw new HttpError(
        502,
        `Service '${id}' registry source is unreachable. Use PATCH to update with a direct download URL, or reinstall from a registry first.`,
      );
    }

    const iconColumns = await resolveIconUpdate(
      registry.icon,
      service.iconHash,
      "service",
      id,
    );

    if (
      registry.hash &&
      registry.hash === service.hash &&
      registry.version === service.version
    ) {
      await this.persistServiceIcon(id, iconColumns);
      return;
    }

    const definitionContent = await this.downloadDefinition(
      registry.downloadUrl,
    );
    const hash = computeContentHash(definitionContent);

    if (hash === service.hash && registry.version === service.version) {
      await this.persistServiceIcon(id, iconColumns);
      return;
    }

    const parsedDefinition = await this.controller.generateDefinition({
      definition: definitionContent,
      adapter: service.adapter,
    });

    for (const tool of parsedDefinition.tools) {
      if (!IDENTIFIER_SCHEMA.safeParse(tool.id).success) {
        throw new HttpError(
          400,
          `Tool id '${tool.id}' must be a valid TypeScript identifier.`,
        );
      }
    }

    try {
      await db.transaction(async (tx) => {
        const existingTools = await tx
          .select({ id: tools.id, enabled: tools.enabled })
          .from(tools)
          .where(eq(tools.serviceId, id));

        const enabledMap = new Map(existingTools.map((t) => [t.id, t.enabled]));

        await tx
          .update(services)
          .set({
            ...parsedDefinition,
            summary: normalizeSummary(parsedDefinition.summary),
            hash,
            version: registry.version,
            enabled: false,
            definitionContent,
            stale: false,
            ...(iconColumns ?? {}),
          })
          .where(eq(services.id, id));

        await tx.delete(tools).where(eq(tools.serviceId, id));

        if (parsedDefinition.tools.length) {
          await tx.insert(tools).values(
            parsedDefinition.tools.map((tool) => ({
              ...tool,
              summary: normalizeSummary(tool.summary),
              serviceId: id,
              enabled: enabledMap.get(tool.id) ?? false,
            })),
          );
        }
      });
    } catch {
      throw new HttpError(500, `Failed to update service '${id}'.`);
    }

    await this.reindexServiceSearch(id);

    try {
      await this.controller.dehydrateService(service.adapter, id);
    } catch (err) {
      logger.warn(
        {
          event: "dehydrate-failed-update",
          err,
          adapterId: service.adapter,
          serviceId: id,
        },
        "Failed to dehydrate service on update",
      );
    }
  }

  private async persistServiceIcon(
    id: string,
    iconColumns: IconColumns | undefined,
  ): Promise<void> {
    if (!iconColumns) return;
    await db
      .update(services)
      .set(iconColumns)
      .where(eq(services.id, id))
      .catch(() => {
        throw new HttpError(500, `Failed to update icon for service '${id}'.`);
      });
  }

  async patchService(id: string, url: string): Promise<{ updated: boolean }> {
    const [service] = await db
      .select({
        adapter: services.adapter,
        hash: services.hash,
      })
      .from(services)
      .where(eq(services.id, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, `Failed to load service '${id}'.`);
      });

    if (!service) throw new HttpError(404, `Service '${id}' not found.`);

    const definitionContent = await this.downloadDefinition(url);
    const hash = computeContentHash(definitionContent);

    if (hash === service.hash) {
      return { updated: false };
    }

    const generatedDefinition = await this.controller.generateDefinition({
      definition: definitionContent,
      adapter: service.adapter,
    });

    for (const tool of generatedDefinition.tools) {
      if (!IDENTIFIER_SCHEMA.safeParse(tool.id).success) {
        throw new HttpError(
          400,
          `Tool id '${tool.id}' must be a valid TypeScript identifier.`,
        );
      }
    }

    try {
      await db.transaction(async (tx) => {
        const existingTools = await tx
          .select({ id: tools.id, enabled: tools.enabled })
          .from(tools)
          .where(eq(tools.serviceId, id));

        const enabledMap = new Map(existingTools.map((t) => [t.id, t.enabled]));

        await tx
          .update(services)
          .set({
            ...generatedDefinition,
            summary: normalizeSummary(generatedDefinition.summary),
            hash,
            version: "0.0.0",
            source: "",
            enabled: false,
            definitionContent,
            stale: false,
            iconData: null,
            iconMime: null,
            iconHash: null,
          })
          .where(eq(services.id, id));

        await tx.delete(tools).where(eq(tools.serviceId, id));

        if (generatedDefinition.tools.length) {
          await tx.insert(tools).values(
            generatedDefinition.tools.map((tool) => ({
              ...tool,
              summary: normalizeSummary(tool.summary),
              serviceId: id,
              enabled: enabledMap.get(tool.id) ?? false,
            })),
          );
        }
      });
    } catch {
      throw new HttpError(500, `Failed to patch service '${id}'.`);
    }

    await this.reindexServiceSearch(id);

    try {
      await this.controller.dehydrateService(service.adapter, id);
    } catch (err) {
      logger.warn(
        {
          event: "dehydrate-failed-patch",
          err,
          adapterId: service.adapter,
          serviceId: id,
        },
        "Failed to dehydrate service on patch",
      );
    }

    return { updated: true };
  }

  async deleteService(id: string): Promise<void> {
    const [deleted] = await db
      .delete(services)
      .where(eq(services.id, id))
      .returning({ id: services.id, adapter: services.adapter })
      .catch(() => {
        throw new HttpError(500, `Failed to delete service '${id}'.`);
      });

    if (!deleted) throw new HttpError(404, `Service '${id}' not found.`);

    await this.deleteServiceSearch(id);

    try {
      await this.controller.dehydrateService(deleted.adapter, id);
    } catch (err) {
      logger.warn(
        {
          event: "dehydrate-failed-delete",
          err,
          adapterId: deleted.adapter,
          serviceId: id,
        },
        "Failed to dehydrate service on delete",
      );
    }
  }

  async setServiceEnabled(input: SetServiceEnabledInput): Promise<void> {
    if (input.enabled) {
      const [row] = await db
        .select({ stale: services.stale })
        .from(services)
        .where(eq(services.id, input.id))
        .limit(1)
        .catch(() => [] as { stale: boolean }[]);

      if (row?.stale) {
        throw new HttpError(
          409,
          `Service '${input.id}' is stale and must be synced before it can be enabled.`,
        );
      }

      const [moduleState] = await db
        .select({
          moduleEnabled: modulesTable.enabled,
          moduleMissing: modulesTable.missing,
          adapter: services.adapter,
        })
        .from(services)
        .innerJoin(modulesTable, eq(services.adapter, modulesTable.id))
        .where(eq(services.id, input.id))
        .limit(1);

      if (!moduleState) {
        throw new HttpError(404, `Service '${input.id}' not found.`);
      }

      if (!moduleState.moduleEnabled) {
        throw new HttpError(
          409,
          `Service '${input.id}' belongs to the disabled module '${moduleState.adapter}' and cannot be enabled.`,
        );
      }

      if (moduleState.moduleMissing) {
        throw new HttpError(
          409,
          `Service '${input.id}' belongs to the missing module '${moduleState.adapter}' and cannot be enabled.`,
        );
      }

      const [config, schema] = await Promise.all([
        this.getServiceConfig(input.id),
        this.getServiceConfigSchema(input.id),
      ]);
      if (!isNullOnlySchema(schema)) {
        applyJsonSchemaDefaults(
          schema,
          filterPayloadToSchema(schema, config),
          `Invalid configuration for service '${input.id}'.`,
        );
      }

      const [secrets, secretsSchema] = await Promise.all([
        this.loadServiceSecrets(input.id),
        this.getServiceSecretsSchema(input.id),
      ]);
      if (!isNullOnlySchema(secretsSchema)) {
        applyJsonSchemaDefaults(
          secretsSchema,
          filterPayloadToSchema(secretsSchema, secrets),
          `Invalid secrets for service '${input.id}'.`,
        );
      }
    }

    const [updated] = await db
      .update(services)
      .set({ enabled: input.enabled })
      .where(eq(services.id, input.id))
      .returning({ id: services.id, adapter: services.adapter })
      .catch((err) => {
        if (err instanceof HttpError) throw err;
        throw new HttpError(
          500,
          `Failed to update enabled status for service '${input.id}'.`,
        );
      });

    if (!updated) throw new HttpError(404, `Service '${input.id}' not found.`);

    if (input.enabled) {
      try {
        const state = await this.buildServiceState(input.id);
        await this.controller.hydrateService(updated.adapter, state);
      } catch (err) {
        await db
          .update(services)
          .set({ enabled: false })
          .where(eq(services.id, input.id))
          .catch((rollbackErr) => {
            logger.error(
              {
                event: "rollback-enabled-flag-failed",
                err: rollbackErr,
                serviceId: input.id,
              },
              "Failed to roll back enabled flag after hydrate failure",
            );
          });

        if (err instanceof HttpError) throw err;
        throw new HttpError(
          502,
          `Failed to hydrate service '${input.id}' on adapter '${updated.adapter}'.`,
        );
      }
    } else {
      try {
        await this.controller.dehydrateService(updated.adapter, input.id);
      } catch (err) {
        logger.warn(
          {
            event: "dehydrate-failed-disable",
            err,
            adapterId: updated.adapter,
            serviceId: input.id,
          },
          "Failed to dehydrate service on disable",
        );
      }
    }
  }

  async setToolEnabled(input: SetToolEnablesInput): Promise<void> {
    const [updated] = await db
      .update(tools)
      .set({ enabled: input.enabled })
      .where(
        and(eq(tools.serviceId, input.serviceId), eq(tools.id, input.toolId)),
      )
      .returning({ id: tools.id })
      .catch(() => {
        throw new HttpError(
          500,
          `Failed to update enabled status for tool '${input.toolId}' in service '${input.serviceId}'.`,
        );
      });

    if (!updated)
      throw new HttpError(
        404,
        `Tool '${input.toolId}' not found in service '${input.serviceId}'.`,
      );
  }

  async getServiceConfig(id: string): Promise<Record<string, unknown>> {
    const [row] = await db
      .select({ payload: serviceConfigurations.payload })
      .from(serviceConfigurations)
      .where(eq(serviceConfigurations.serviceId, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, "Failed to load configuration.");
      });

    const payload = row?.payload;
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  }

  async getServiceConfigView(id: string): Promise<ServiceConfigView> {
    const [schema, config] = await Promise.all([
      this.getServiceConfigSchema(id),
      this.getServiceConfig(id),
    ]);
    if (isNullOnlySchema(schema)) {
      return { config, outdated: [] };
    }
    return {
      config: filterPayloadToSchema(schema, config),
      outdated: collectOutdatedPaths(schema, config),
    };
  }

  async getServiceSecretsPresence(id: string): Promise<SecretsPresence> {
    const [schema, payload] = await Promise.all([
      this.getServiceSecretsSchema(id),
      this.loadServiceSecrets(id),
    ]);
    if (isNullOnlySchema(schema)) {
      return { present: collectPresentPaths(payload), outdated: [] };
    }
    return {
      present: collectPresentPaths(
        filterPayloadToSchema(schema, payload, { keepPermitted: true }),
      ),
      outdated: collectOutdatedPaths(schema, payload),
    };
  }

  async getServiceConfigSchema(id: string): Promise<JSONSchema> {
    const [row] = await db
      .select({ configSchema: services.configSchema })
      .from(services)
      .where(eq(services.id, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, "Failed to load configuration schema.");
      });

    if (!row) throw new HttpError(404, `Service '${id}' not found.`);
    return row.configSchema;
  }

  async patchServiceConfig(input: PatchInput): Promise<ServiceConfigView> {
    const [current, schema] = await Promise.all([
      this.getServiceConfig(input.id),
      this.getServiceConfigSchema(input.id),
    ]);

    const patch = input.patch.filter(
      (op) => !(op.op === "remove" && !pathExists(current, op.path)),
    );

    let updated: Record<string, unknown>;
    try {
      const result = jsonpatch.applyPatch(
        current,
        patch,
        true,
        false,
      ).newDocument;
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new HttpError(
          400,
          "Configuration payload must be a JSON object.",
        );
      }
      updated = result as Record<string, unknown>;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(
        400,
        err instanceof Error ? err.message : "Invalid JSON Patch payload.",
      );
    }

    const nullOnly = isNullOnlySchema(schema);
    if (!nullOnly) {
      const added = newOutdatedPaths(
        collectOutdatedPaths(schema, current),
        collectOutdatedPaths(schema, updated),
      );
      if (added.length > 0) {
        throw new HttpError(
          400,
          `Invalid configuration for service '${input.id}': schema-disallowed keys ${added.join(", ")} cannot be added.`,
        );
      }
    }

    const payload = nullOnly
      ? updated
      : mergeStaleKeys(
          applyJsonSchemaDefaults(
            schema,
            filterPayloadToSchema(schema, updated),
            `Invalid configuration for service '${input.id}'.`,
          ),
          updated,
        );

    await db
      .insert(serviceConfigurations)
      .values({ serviceId: input.id, payload, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: serviceConfigurations.serviceId,
        set: { payload, updatedAt: Date.now() },
      })
      .catch(() => {
        throw new HttpError(
          500,
          `Failed to persist configuration for service '${input.id}'.`,
        );
      });

    await this.hydrateIfEnabled(input.id);

    return {
      config: nullOnly ? payload : filterPayloadToSchema(schema, payload),
      outdated: collectOutdatedPaths(schema, payload),
    };
  }

  async getServiceSecretsSchema(id: string): Promise<JSONSchema> {
    const [row] = await db
      .select({ secretsSchema: services.secretsSchema })
      .from(services)
      .where(eq(services.id, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, "Failed to load secrets schema.");
      });

    if (!row) throw new HttpError(404, `Service '${id}' not found.`);
    return row.secretsSchema;
  }

  async patchServiceSecrets(input: PatchInput): Promise<void> {
    const [schema, current] = await Promise.all([
      this.getServiceSecretsSchema(input.id),
      this.loadServiceSecrets(input.id),
    ]);

    const patch = input.patch.filter(
      (op) => !(op.op === "remove" && !pathExists(current, op.path)),
    );

    let updated: Record<string, unknown>;
    try {
      updated = (() => {
        const result = jsonpatch.applyPatch(
          current,
          patch,
          true,
          false,
        ).newDocument;
        if (result && typeof result === "object" && !Array.isArray(result)) {
          return result as Record<string, unknown>;
        }
        throw new HttpError(400, "Secrets payload must be a JSON object.");
      })();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(
        400,
        err instanceof Error ? err.message : "Invalid JSON Patch payload.",
      );
    }

    const nullOnly = isNullOnlySchema(schema);
    if (!nullOnly) {
      const added = newOutdatedPaths(
        collectOutdatedPaths(schema, current),
        collectOutdatedPaths(schema, updated),
      );
      if (added.length > 0) {
        throw new HttpError(
          400,
          `Invalid secrets for service '${input.id}': schema-disallowed keys ${added.join(", ")} cannot be added.`,
        );
      }
    }

    const payload = nullOnly
      ? updated
      : mergeStaleKeys(
          applyJsonSchemaDefaults(
            schema,
            filterPayloadToSchema(schema, updated),
            `Invalid secrets for service '${input.id}'.`,
          ),
          updated,
        );

    const encrypted = encryptSecrets(payload);

    await db
      .insert(serviceSecrets)
      .values({
        serviceId: input.id,
        payload: encrypted,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: serviceSecrets.serviceId,
        set: { payload: encrypted, updatedAt: Date.now() },
      })
      .catch(() => {
        throw new HttpError(
          500,
          `Failed to persist secrets for service '${input.id}'.`,
        );
      });

    await this.hydrateIfEnabled(input.id);
  }

  async hydrateAdapter(adapterId: string): Promise<void> {
    const rows = await db
      .select({ id: services.id })
      .from(services)
      .where(
        and(
          eq(services.adapter, adapterId),
          eq(services.enabled, true),
          eq(services.stale, false),
        ),
      )
      .catch((err) => {
        logger.warn(
          { event: "adapter-load-services-failed", err, adapterId },
          "Failed to load services for adapter activation",
        );
        return [] as { id: string }[];
      });

    await Promise.all(
      rows.map(async (row) => {
        try {
          const state = await this.buildServiceState(row.id);
          await this.controller.hydrateService(adapterId, state);
        } catch (err) {
          logger.warn(
            {
              event: "adapter-hydrate-service-failed",
              err,
              adapterId,
              serviceId: row.id,
            },
            "Failed to hydrate service on adapter activation",
          );
        }
      }),
    );
  }

  private async hydrateIfEnabled(id: string): Promise<void> {
    const [row] = await db
      .select({
        enabled: services.enabled,
        stale: services.stale,
        adapter: services.adapter,
      })
      .from(services)
      .where(eq(services.id, id))
      .limit(1)
      .catch(
        () => [] as { enabled: boolean; stale: boolean; adapter: string }[],
      );

    if (!row?.enabled || row.stale) return;

    const state = await this.buildServiceState(id);
    await this.controller.hydrateService(row.adapter, state);
  }

  private async buildServiceState(id: string): Promise<ServiceState> {
    const [serviceRow] = await db
      .select({ adapterDomain: services.adapterDomain })
      .from(services)
      .where(eq(services.id, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, `Failed to load service '${id}'.`);
      });

    if (!serviceRow) throw new HttpError(404, `Service '${id}' not found.`);

    const [toolRows, config, secrets, configSchema, secretsSchema] =
      await Promise.all([
        db
          .select({ id: tools.id, adapterDomain: tools.adapterDomain })
          .from(tools)
          .where(eq(tools.serviceId, id))
          .catch(() => {
            throw new HttpError(
              500,
              `Failed to load tools for service '${id}'.`,
            );
          }),
        this.getServiceConfig(id),
        this.loadServiceSecrets(id),
        this.getServiceConfigSchema(id),
        this.getServiceSecretsSchema(id),
      ]);

    return {
      id,
      adapterDomain: serviceRow.adapterDomain,
      tools: Object.fromEntries(
        toolRows.map((t) => [t.id, { adapterDomain: t.adapterDomain }]),
      ),
      config: isNullOnlySchema(configSchema)
        ? config
        : applyJsonSchemaDefaults(
            configSchema,
            // Conformant projection: validates identically to the
            // declared-only projection (permitted keys are unconstrained)
            // while delivering schema-permitted keys to the adapter.
            filterPayloadToSchema(configSchema, config, {
              keepPermitted: true,
            }),
            `Invalid configuration for service '${id}'.`,
          ),
      secrets: isNullOnlySchema(secretsSchema)
        ? secrets
        : applyJsonSchemaDefaults(
            secretsSchema,
            filterPayloadToSchema(secretsSchema, secrets, {
              keepPermitted: true,
            }),
            `Invalid secrets for service '${id}'.`,
          ),
    };
  }

  private async loadServiceSecrets(
    id: string,
  ): Promise<Record<string, unknown>> {
    const [row] = await db
      .select({ payload: serviceSecrets.payload })
      .from(serviceSecrets)
      .where(eq(serviceSecrets.serviceId, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, `Failed to load secrets for service '${id}'.`);
      });

    if (!row?.payload) return {};

    const parsed = encryptedSecretsSchema.safeParse(row.payload);
    if (!parsed.success)
      throw new HttpError(500, "Stored secrets payload is malformed.");

    return decryptAndMaybeReEncrypt(
      parsed.data,
      async (reEncrypted) => {
        await db
          .update(serviceSecrets)
          .set({ payload: reEncrypted, updatedAt: Date.now() })
          .where(eq(serviceSecrets.serviceId, id));
      },
      { serviceId: id },
    );
  }

  private async downloadDefinition(fileUrl: string): Promise<string> {
    return downloadText(fileUrl, DEFINITION_DOWNLOAD_MAX_BYTES, "definition");
  }

  private async reindexServiceSearch(serviceId: string): Promise<void> {
    if (!this.search) return;
    try {
      await this.search.reindexService(serviceId);
    } catch (err) {
      logger.warn(
        {
          event: "reindex-embeddings-failed",
          err,
          serviceId,
        },
        "Failed to regenerate tool embeddings; reconciliation will retry",
      );
    }
  }

  private async deleteServiceSearch(serviceId: string): Promise<void> {
    if (!this.search) return;
    try {
      await this.search.deleteEmbeddings(serviceId);
    } catch (err) {
      logger.warn(
        { event: "delete-embeddings-failed", err, serviceId },
        "Failed to delete tool embeddings; reconciliation will retry",
      );
    }
  }
}

function isUniqueConstraintError(
  err: unknown,
  seen = new Set<unknown>(),
): boolean {
  if (!err || typeof err !== "object" || seen.has(err)) return false;
  seen.add(err);
  const { code, message } = err as { code?: unknown; message?: unknown };
  const c = typeof code === "string" ? code : "";
  const m = typeof message === "string" ? message : "";
  if (
    c === "23505" ||
    /^SQLITE_CONSTRAINT_(UNIQUE|PRIMARYKEY)$/i.test(c) ||
    /UNIQUE constraint failed:|duplicate key value|\bduplicate key\b|violates unique constraint/i.test(
      m,
    )
  ) {
    return true;
  }
  return isUniqueConstraintError((err as { cause?: unknown }).cause, seen);
}
