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
  SetServiceEnabledInput,
  SetToolEnablesInput,
} from "@/models/services.model";
import { downloadText } from "@/utils/download.util";
import { computeContentHash } from "@/utils/hash.util";
import { decryptSecrets, encryptSecrets } from "@/utils/secrets.util";
import {
  applyJsonSchemaDefaults,
  validateJsonSchema,
} from "@/utils/validation.util";

const DEFINITION_DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024;
const IDENTIFIER_SCHEMA = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/);

export interface AdapterController {
  generateDefinition(
    input: GenerateDefinitionInput,
  ): Promise<ServiceDefinition>;
  hydrateService(adapterId: string, state: ServiceState): Promise<void>;
  dehydrateService(adapterId: string, serviceId: string): Promise<void>;
  generateToolDocs(input: ToolDocsInput): Promise<string>;
}

const encryptedSecretsSchema = z.object({
  alg: z.literal("aes-256-gcm"),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

export class ServicesService {
  constructor(private readonly controller: AdapterController) {}

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
        ...serviceColumns
      } = getTableColumns(services);

      const query = db
        .select({
          ...serviceColumns,
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
                  like(services.description, `%${normalizedQuery}%`),
                )
              : undefined,
          ),
        )
        .orderBy(asc(services.id));

      return await (input?.limit !== undefined
        ? query.limit(Number(input.limit))
        : query);
    } catch {
      throw new HttpError(500, "Failed to list services.");
    }
  }

  async getService(id: string): Promise<GetServiceDefinitionResult> {
    const { adapterDomain, definitionContent, ...serviceColumns } =
      getTableColumns(services);
    const [row] = await db
      .select({
        ...serviceColumns,
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
    return row;
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

    const query = db
      .select({
        serviceId: tools.serviceId,
        id: tools.id,
        name: tools.name,
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
          id: input.id,
          hash,
          source: "",
          adapter: input.adapter,
          enabled: false,
          definitionContent,
        });
        await tx.insert(tools).values(
          generatedDefinition.tools.map((tool) => ({
            ...tool,
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
  }

  async createServiceFromRegistry(
    input: RegistryInstallServiceInput,
  ): Promise<string> {
    const { resolveServiceRegistry } = await import("@/utils/registry.util");
    const registry = await resolveServiceRegistry(input.source);

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

    const definitionContent = await this.downloadDefinition(
      registry.downloadUrl,
    );
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
          id: effectiveId,
          hash: contentHash,
          source: input.source,
          adapter: effectiveAdapter,
          enabled: false,
          definitionContent,
        });
        await tx.insert(tools).values(
          generatedDefinition.tools.map((tool) => ({
            ...tool,
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
          .select({ name: tools.name, enabled: tools.enabled })
          .from(tools)
          .where(eq(tools.serviceId, id));

        const enabledMap = new Map(
          existingTools.map((t) => [t.name, t.enabled]),
        );

        await tx
          .update(services)
          .set({
            ...generatedDefinition,
            enabled: false,
            stale: false,
          })
          .where(eq(services.id, id));

        await tx.delete(tools).where(eq(tools.serviceId, id));

        if (generatedDefinition.tools.length) {
          await tx.insert(tools).values(
            generatedDefinition.tools.map((tool) => ({
              ...tool,
              serviceId: id,
              enabled: enabledMap.get(tool.name) ?? false,
            })),
          );
        }
      });
    } catch {
      throw new HttpError(500, `Failed to sync service '${id}'.`);
    }

    try {
      await this.controller.dehydrateService(service.adapter, id);
    } catch (err) {
      logger.warn(
        { err, adapterId: service.adapter, serviceId: id },
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

    let registry: { downloadUrl: string; hash?: string };
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

    if (registry.hash && registry.hash === service.hash) return;

    const definitionContent = await this.downloadDefinition(
      registry.downloadUrl,
    );
    const hash = computeContentHash(definitionContent);

    if (hash === service.hash) return;

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
          .select({ name: tools.name, enabled: tools.enabled })
          .from(tools)
          .where(eq(tools.serviceId, id));

        const enabledMap = new Map(
          existingTools.map((t) => [t.name, t.enabled]),
        );

        await tx
          .update(services)
          .set({
            ...parsedDefinition,
            hash,
            enabled: false,
            definitionContent,
            stale: false,
          })
          .where(eq(services.id, id));

        await tx.delete(tools).where(eq(tools.serviceId, id));

        if (parsedDefinition.tools.length) {
          await tx.insert(tools).values(
            parsedDefinition.tools.map((tool) => ({
              ...tool,
              serviceId: id,
              enabled: enabledMap.get(tool.name) ?? false,
            })),
          );
        }
      });
    } catch {
      throw new HttpError(500, `Failed to update service '${id}'.`);
    }

    try {
      await this.controller.dehydrateService(service.adapter, id);
    } catch (err) {
      logger.warn(
        { err, adapterId: service.adapter, serviceId: id },
        "Failed to dehydrate service on update",
      );
    }
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
          .select({ name: tools.name, enabled: tools.enabled })
          .from(tools)
          .where(eq(tools.serviceId, id));

        const enabledMap = new Map(
          existingTools.map((t) => [t.name, t.enabled]),
        );

        await tx
          .update(services)
          .set({
            ...generatedDefinition,
            hash,
            source: "",
            enabled: false,
            definitionContent,
            stale: false,
          })
          .where(eq(services.id, id));

        await tx.delete(tools).where(eq(tools.serviceId, id));

        if (generatedDefinition.tools.length) {
          await tx.insert(tools).values(
            generatedDefinition.tools.map((tool) => ({
              ...tool,
              serviceId: id,
              enabled: enabledMap.get(tool.name) ?? false,
            })),
          );
        }
      });
    } catch {
      throw new HttpError(500, `Failed to patch service '${id}'.`);
    }

    try {
      await this.controller.dehydrateService(service.adapter, id);
    } catch (err) {
      logger.warn(
        { err, adapterId: service.adapter, serviceId: id },
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

    try {
      await this.controller.dehydrateService(deleted.adapter, id);
    } catch (err) {
      logger.warn(
        { err, adapterId: deleted.adapter, serviceId: id },
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
          config,
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
          secrets,
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
              { err: rollbackErr, serviceId: input.id },
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
          { err, adapterId: updated.adapter, serviceId: input.id },
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

  async patchServiceConfig(input: PatchInput): Promise<void> {
    const [current, schema] = await Promise.all([
      this.getServiceConfig(input.id),
      this.getServiceConfigSchema(input.id),
    ]);

    let updated: Record<string, unknown>;
    try {
      const result = jsonpatch.applyPatch(
        current,
        input.patch,
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
      validateJsonSchema(
        schema,
        updated,
        `Invalid configuration for service '${input.id}'.`,
      );
    }

    const payload = nullOnly
      ? updated
      : applyJsonSchemaDefaults(
          schema,
          updated,
          `Invalid configuration for service '${input.id}'.`,
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

    let updated: Record<string, unknown>;
    try {
      updated = (() => {
        const result = jsonpatch.applyPatch(
          current,
          input.patch,
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

    validateJsonSchema(
      schema,
      updated,
      `Invalid secrets for service '${input.id}'.`,
    );

    const payload = isNullOnlySchema(schema)
      ? updated
      : applyJsonSchemaDefaults(
          schema,
          updated,
          `Invalid secrets for service '${input.id}'.`,
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
          { err, adapterId },
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
            { err, adapterId, serviceId: row.id },
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

    const [toolRows, config, secrets] = await Promise.all([
      db
        .select({ name: tools.name, adapterDomain: tools.adapterDomain })
        .from(tools)
        .where(eq(tools.serviceId, id))
        .catch(() => {
          throw new HttpError(500, `Failed to load tools for service '${id}'.`);
        }),
      this.getServiceConfig(id),
      this.loadServiceSecrets(id),
    ]);

    return {
      id,
      adapterDomain: serviceRow.adapterDomain,
      tools: Object.fromEntries(
        toolRows.map((t) => [t.name, { adapterDomain: t.adapterDomain }]),
      ),
      config,
      secrets,
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

    return decryptSecrets(parsed.data);
  }

  private async downloadDefinition(fileUrl: string): Promise<string> {
    return downloadText(fileUrl, DEFINITION_DOWNLOAD_MAX_BYTES, "definition");
  }
}

function isNullOnlySchema(schema: Record<string, unknown>): boolean {
  const t = schema.type;
  return (
    t === "null" || (Array.isArray(t) && t.length === 1 && t[0] === "null")
  );
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
