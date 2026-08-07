import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import oapi from "@cyrnel/openapi";
import type {
  AdapterModule,
  EnvironmentBindings,
  EnvironmentModule,
  ExecutionExitState,
  ExecutionInput,
  InvokeInput,
  JSONSchema,
  Module,
  ModuleExport,
  ModuleSetupContext,
  ServiceDefinition,
  ServiceState,
  ToolDocsInput,
} from "@cyrnel/sdk";
import tsivm from "@cyrnel/typescript-ivm";
import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import jsonpatch from "fast-json-patch";
import { decompress as zstdDecompress } from "fzstd";
import { satisfies } from "semver";
import { Unpack } from "tar";
import { z } from "zod";

import { CYRNEL_CORE_VERSION } from "@/constants";
import { db } from "@/db/client";
import {
  type ModuleRecord,
  moduleConfigurations,
  moduleSecrets,
  modules as modulesTable,
  services as servicesTable,
  tools as toolsTable,
} from "@/db/schema";
import { logger } from "@/infra/logging/logger";
import { HttpError } from "@/models/error.model";
import {
  type FilterModuleManifestInput,
  type GenerateDefinitionInput,
  type GetModuleManifestResult,
  type ListModuleManifestResult,
  type ModuleConfigView,
  type ModuleManifestRecord,
  type ModuleManifestSchema,
  type ModuleSecretsPresence,
  type ModuleType,
  moduleManifestSchema,
  type PatchModuleConfigInput,
  type PatchModuleSecretsInput,
  type SetModuleEnabledInput,
} from "@/models/modules.model";
import { downloadBinary } from "@/utils/download.util";
import { computeBinaryHash } from "@/utils/hash.util";
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
  assertPlainJsonSchema,
  normalizeSummary,
} from "@/utils/validation.util";

const MODULE_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_INVOKE_TIMEOUT_MS = 30_000;
const IDENTIFIER_SCHEMA = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/);

interface ModuleFactory {
  type: ModuleType;
  configSchema: JSONSchema;
  secretsSchema: JSONSchema;
  instantiate(): Module;
}

interface AdapterLifecycle {
  hydrateAdapter(adapterId: string): Promise<void>;
}

interface RegisteredModule {
  id: string;
  name: string;
  summary: string;
  description: string;
  type: ModuleType;
  version: string;
  isBuiltin: boolean;
  configSchema: JSONSchema;
  secretsSchema: JSONSchema;
}

interface ValidatedSetupValues {
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
}

type JsonObject = Record<string, unknown>;

const encryptedSecretsSchema = z.object({
  kid: z.string().optional(),
  alg: z.literal("aes-256-gcm"),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

const EMPTY_OBJECT_SCHEMA: JSONSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

interface EnvironmentInstance {
  id: string;
  module: EnvironmentModule;
  executions: Set<number>;
  drain: (() => void) | null;
  drained: Promise<void> | null;
  disposed: Promise<void> | null;
}

export class ModuleService {
  private readonly factories = new Map<string, ModuleFactory>();
  private readonly manifests = new Map<string, RegisteredModule>();
  private readonly adapters = new Map<string, AdapterModule>();
  private readonly drainingEnvironments = new Set<EnvironmentInstance>();
  private activeEnvironment: EnvironmentInstance | null = null;
  private readonly executionMap = new Map<number, EnvironmentInstance>();
  private modulesPath: string | null = null;

  constructor(
    private readonly bindings: EnvironmentBindings,
    private readonly lifecycle: AdapterLifecycle,
  ) {}

  async initialize(path: string): Promise<void> {
    this.modulesPath = path;
    this.registerBuiltinModules();
    await this.registerCustomModules(path);
    await this.reconcile();

    const stateRows = await db.select().from(modulesTable);
    const active = stateRows.filter((r) => r.enabled && !r.missing);

    await Promise.all(
      active
        .filter((r) => r.type === "adapter")
        .map((r) => this.activateAdapter(r.id)),
    );

    const env = active.find((r) => r.type === "environment");
    if (env) await this.activateEnvironment(env.id);
  }

  async shutdown(): Promise<void> {
    if (this.activeEnvironment) {
      this.markDraining(this.activeEnvironment);
      this.activeEnvironment = null;
    }

    const draining = Array.from(this.drainingEnvironments);

    await Promise.all(
      draining.flatMap((instance) =>
        Array.from(instance.executions).map((eid) =>
          instance.module.kill(eid).catch((err) => {
            logger.warn(
              {
                event: "execution-kill-failed",
                err,
                environmentId: instance.id,
                eid,
              },
              "Failed to kill execution during shutdown",
            );
          }),
        ),
      ),
    );
    await Promise.all(draining.map((i) => i.disposed ?? Promise.resolve()));
    await Promise.all(
      Array.from(this.adapters.entries()).map(([id, a]) =>
        a.teardown().catch((err) => {
          logger.warn(
            { event: "adapter-teardown-failed", err, adapterId: id },
            "Adapter teardown failed",
          );
        }),
      ),
    );

    this.adapters.clear();
  }

  async execute(input: ExecutionInput): Promise<ExecutionExitState> {
    const instance = this.requireActiveEnvironment();
    instance.executions.add(input.eid);
    this.executionMap.set(input.eid, instance);
    try {
      return await instance.module.execute(input);
    } finally {
      instance.executions.delete(input.eid);
      this.executionMap.delete(input.eid);
      if (instance.drained && instance.executions.size === 0)
        instance.drain?.();
    }
  }

  async kill(eid: number): Promise<void> {
    const instance = this.executionMap.get(eid);
    if (!instance) return;
    await instance.module.kill(eid);
  }

  async generateEnvironmentDocs(): Promise<string> {
    const instance = this.requireActiveEnvironment();
    return instance.module.generateDocs();
  }

  async generateToolDocs(input: ToolDocsInput): Promise<string> {
    const instance = this.requireActiveEnvironment();
    return instance.module.generateToolDocs(input);
  }

  generateDefinition(
    input: GenerateDefinitionInput,
  ): Promise<ServiceDefinition> {
    return this.requireAdapter(input.adapter).generateDefinition(
      input.definition,
    );
  }

  async hydrateService(adapterId: string, state: ServiceState): Promise<void> {
    await this.requireAdapter(adapterId).hydrateService(state);
  }

  async dehydrateService(adapterId: string, serviceId: string): Promise<void> {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) return;
    await adapter.dehydrateService(serviceId);
  }

  async invoke(input: InvokeInput): Promise<unknown> {
    const [row] = await db
      .select({
        adapter: servicesTable.adapter,
        serviceEnabled: servicesTable.enabled,
        serviceStale: servicesTable.stale,
        toolEnabled: toolsTable.enabled,
      })
      .from(servicesTable)
      .leftJoin(
        toolsTable,
        and(
          eq(toolsTable.serviceId, servicesTable.id),
          eq(toolsTable.id, input.toolId),
        ),
      )
      .where(eq(servicesTable.id, input.serviceId))
      .limit(1);

    if (!row) {
      throw new HttpError(404, `Service '${input.serviceId}' not found.`);
    }

    if (row.toolEnabled === null) {
      throw new HttpError(
        404,
        `Tool '${input.toolId}' not found in service '${input.serviceId}'.`,
      );
    }

    if (row.serviceStale) {
      throw new HttpError(
        409,
        `Service '${input.serviceId}' is stale and must be synced before it can be invoked.`,
      );
    }

    if (!row.serviceEnabled) {
      throw new HttpError(409, `Service '${input.serviceId}' is disabled.`);
    }

    if (!row.toolEnabled) {
      throw new HttpError(
        409,
        `Tool '${input.toolId}' in service '${input.serviceId}' is disabled.`,
      );
    }

    return await this.invokeAdapterWithTimeout(row.adapter, input);
  }

  async list(
    filters: FilterModuleManifestInput = {},
  ): Promise<ListModuleManifestResult[]> {
    const conditions = [];
    if (filters.type !== undefined) {
      conditions.push(eq(modulesTable.type, filters.type));
    }
    if (filters.enabled !== undefined) {
      conditions.push(eq(modulesTable.enabled, filters.enabled));
    }
    if (filters.missing !== undefined) {
      conditions.push(eq(modulesTable.missing, filters.missing));
    }

    const { iconData, iconMime, ...moduleColumns } =
      getTableColumns(modulesTable);

    const rows = await db
      .select({
        ...moduleColumns,
        iconHash: modulesTable.iconHash,
      })
      .from(modulesTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(modulesTable.id));

    const query = filters.query?.trim().toLowerCase();
    return rows
      .filter((row) =>
        filters.isBuiltin === undefined
          ? true
          : this.isBuiltin(row.id) === filters.isBuiltin,
      )
      .filter((row) =>
        query
          ? `${row.id}\n${row.name}\n${row.summary}\n${row.description}`
              .toLowerCase()
              .includes(query)
          : true,
      )
      .map((row) => this.toListRecord(row));
  }

  async get(id: string): Promise<GetModuleManifestResult | undefined> {
    const { iconData, iconMime, ...moduleColumns } =
      getTableColumns(modulesTable);
    const [row] = await db
      .select({
        ...moduleColumns,
        iconHash: modulesTable.iconHash,
      })
      .from(modulesTable)
      .where(eq(modulesTable.id, id))
      .limit(1);

    return row ? this.toManifestRecord(row) : undefined;
  }

  async getIcon(
    id: string,
  ): Promise<{ data: Buffer; mime: string; hash: string } | null> {
    const [row] = await db
      .select({
        iconData: modulesTable.iconData,
        iconMime: modulesTable.iconMime,
        iconHash: modulesTable.iconHash,
      })
      .from(modulesTable)
      .where(eq(modulesTable.id, id))
      .limit(1);

    if (!row) throw new HttpError(404, `Module '${id}' not found.`);
    if (!row.iconData || !row.iconMime || !row.iconHash) return null;
    return { data: row.iconData, mime: row.iconMime, hash: row.iconHash };
  }

  async setEnabled(input: SetModuleEnabledInput): Promise<void> {
    const [row] = await db
      .select()
      .from(modulesTable)
      .where(eq(modulesTable.id, input.id))
      .limit(1);

    if (!row) throw new HttpError(404, `Module '${input.id}' not found.`);

    if (input.enabled && row.missing) {
      throw new HttpError(
        409,
        `Module '${input.id}' is missing and cannot be enabled.`,
      );
    }

    if (row.enabled === input.enabled) return;

    if (input.enabled) {
      await this.assertConfigAndSecretsValid(input.id);
    }

    if (input.enabled && row.type === "environment") {
      const current = this.activeEnvironment;
      if (current && current.id !== input.id) {
        await db
          .update(modulesTable)
          .set({ enabled: false })
          .where(eq(modulesTable.id, current.id));
        this.deactivateEnvironment(current.id);
      }
    }

    await db
      .update(modulesTable)
      .set({ enabled: input.enabled })
      .where(eq(modulesTable.id, input.id));

    if (input.enabled) {
      if (row.type === "adapter") await this.activateAdapter(input.id);
      else await this.activateEnvironment(input.id);
    } else {
      if (row.type === "adapter") await this.deactivateAdapter(input.id);
      else this.deactivateEnvironment(input.id);
    }
  }

  async getConfig(id: string): Promise<Record<string, unknown>> {
    this.requireRegistered(id);
    const [row] = await db
      .select({ payload: moduleConfigurations.payload })
      .from(moduleConfigurations)
      .where(eq(moduleConfigurations.moduleId, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(
          500,
          `Failed to load configuration for module '${id}'.`,
        );
      });

    const payload = row?.payload;
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  }

  getConfigSchema(id: string): JSONSchema {
    return this.requireRegistered(id).configSchema;
  }

  getSecretsSchema(id: string): JSONSchema {
    return this.requireRegistered(id).secretsSchema;
  }

  async getConfigView(id: string): Promise<ModuleConfigView> {
    const manifest = this.requireRegistered(id);
    const payload = await this.getConfig(id);
    if (isNullOnlySchema(manifest.configSchema)) {
      return { config: payload, outdated: [] };
    }
    return {
      config: filterPayloadToSchema(manifest.configSchema, payload),
      outdated: collectOutdatedPaths(manifest.configSchema, payload),
    };
  }

  async getSecretsPresence(id: string): Promise<ModuleSecretsPresence> {
    const manifest = this.requireRegistered(id);
    const payload = await this.loadSecrets(id);
    if (isNullOnlySchema(manifest.secretsSchema)) {
      return { present: collectPresentPaths(payload), outdated: [] };
    }
    return {
      present: collectPresentPaths(
        filterPayloadToSchema(manifest.secretsSchema, payload, {
          keepPermitted: true,
        }),
      ),
      outdated: collectOutdatedPaths(manifest.secretsSchema, payload),
    };
  }

  async patchConfig(input: PatchModuleConfigInput): Promise<ModuleConfigView> {
    const manifest = this.requireRegistered(input.id);
    const current = await this.getConfig(input.id);
    const nullOnly = isNullOnlySchema(manifest.configSchema);

    const patch = input.patch.filter(
      (op) => !(op.op === "remove" && !pathExists(current, op.path)),
    );

    let updated: JsonObject | null;
    try {
      const result = jsonpatch.applyPatch(
        current,
        patch,
        true,
        false,
      ).newDocument;
      if (result === null && nullOnly) {
        updated = null;
      } else if (
        result &&
        typeof result === "object" &&
        !Array.isArray(result)
      ) {
        updated = result as JsonObject;
      } else {
        throw new HttpError(
          400,
          "Configuration payload must be a JSON object.",
        );
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(
        400,
        err instanceof Error ? err.message : "Invalid JSON Patch payload.",
      );
    }

    let payload: JsonObject | null;
    if (nullOnly) {
      payload = updated;
    } else {
      if (updated === null) {
        throw new HttpError(
          400,
          "Configuration payload must be a JSON object.",
        );
      }
      const added = newOutdatedPaths(
        collectOutdatedPaths(manifest.configSchema, current),
        collectOutdatedPaths(manifest.configSchema, updated),
      );
      if (added.length > 0) {
        throw new HttpError(
          400,
          `Invalid configuration for module '${input.id}': schema-disallowed keys ${added.join(", ")} cannot be added.`,
        );
      }
      payload = mergeStaleKeys(
        applyJsonSchemaDefaults(
          manifest.configSchema,
          filterPayloadToSchema(manifest.configSchema, updated),
          `Invalid configuration for module '${input.id}'.`,
        ),
        updated,
      );
    }

    const storedPayload = payload === null ? sql`'null'` : payload;

    await db
      .insert(moduleConfigurations)
      .values({
        moduleId: input.id,
        payload: storedPayload,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: moduleConfigurations.moduleId,
        set: { payload: storedPayload, updatedAt: Date.now() },
      })
      .catch(() => {
        throw new HttpError(
          500,
          `Failed to persist configuration for module '${input.id}'.`,
        );
      });

    await this.reloadIfActive(input.id);

    return {
      config: nullOnly
        ? payload
        : filterPayloadToSchema(manifest.configSchema, payload ?? {}),
      outdated: collectOutdatedPaths(manifest.configSchema, payload ?? {}),
    };
  }

  async patchSecrets(input: PatchModuleSecretsInput): Promise<void> {
    const manifest = this.requireRegistered(input.id);
    const current = await this.loadSecrets(input.id);

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
        throw new HttpError(400, "Secrets payload must be a JSON object.");
      }
      updated = result as Record<string, unknown>;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(
        400,
        err instanceof Error ? err.message : "Invalid JSON Patch payload.",
      );
    }

    const nullOnly = isNullOnlySchema(manifest.secretsSchema);
    if (!nullOnly) {
      const added = newOutdatedPaths(
        collectOutdatedPaths(manifest.secretsSchema, current),
        collectOutdatedPaths(manifest.secretsSchema, updated),
      );
      if (added.length > 0) {
        throw new HttpError(
          400,
          `Invalid secrets for module '${input.id}': schema-disallowed keys ${added.join(", ")} cannot be added.`,
        );
      }
    }

    const payload = nullOnly
      ? updated
      : mergeStaleKeys(
          applyJsonSchemaDefaults(
            manifest.secretsSchema,
            filterPayloadToSchema(manifest.secretsSchema, updated),
            `Invalid secrets for module '${input.id}'.`,
          ),
          updated,
        );

    const encrypted = encryptSecrets(payload);

    await db
      .insert(moduleSecrets)
      .values({
        moduleId: input.id,
        payload: encrypted,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: moduleSecrets.moduleId,
        set: { payload: encrypted, updatedAt: Date.now() },
      })
      .catch(() => {
        throw new HttpError(
          500,
          `Failed to persist secrets for module '${input.id}'.`,
        );
      });

    await this.reloadIfActive(input.id);
  }

  async reload(): Promise<null> {
    if (this.modulesPath === null) {
      throw new HttpError(503, "ModuleService has not been initialized.");
    }

    this.factories.clear();
    this.manifests.clear();
    this.registerBuiltinModules();
    await this.registerCustomModules(this.modulesPath);
    await this.reconcile();

    const missingAdapters = [...this.adapters.keys()].filter(
      (id) => !this.factories.has(id),
    );
    await Promise.all(missingAdapters.map((id) => this.deactivateAdapter(id)));

    if (
      this.activeEnvironment &&
      !this.factories.has(this.activeEnvironment.id)
    ) {
      this.deactivateEnvironment(this.activeEnvironment.id);
    }

    return null;
  }

  async installModuleDirect(url: string): Promise<ModuleManifestRecord> {
    if (!this.modulesPath) {
      throw new HttpError(503, "ModuleService has not been initialized.");
    }

    const buffer = await downloadBinary(url, MODULE_DOWNLOAD_MAX_BYTES);
    const archiveHash = computeBinaryHash(buffer);

    const { manifest, tmpDir } = await this.extractModuleArchive(buffer);
    this.assertEngineCompatibility(manifest.engines, `Module '${manifest.id}'`);

    if (this.factories.has(manifest.id)) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new HttpError(
        409,
        `Module '${manifest.id}' is already registered.`,
      );
    }
    const [existing] = await db
      .select({ id: modulesTable.id })
      .from(modulesTable)
      .where(eq(modulesTable.id, manifest.id))
      .limit(1);
    if (existing) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new HttpError(409, `Module '${manifest.id}' already exists.`);
    }

    const modulesPath = this.modulesPath as string;
    const installDir = join(modulesPath, manifest.id);
    try {
      await fs.rename(tmpDir, installDir);
    } catch {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new HttpError(500, `Failed to install module '${manifest.id}'.`);
    }

    let configSchema: JSONSchema;
    let secretsSchema: JSONSchema;

    try {
      const imported = (await this.importModuleExport(
        installDir,
        manifest.main,
        archiveHash,
      )) as {
        default: ModuleExport;
      };
      const def = imported.default;
      assertPlainJsonSchema(
        def.configSchema,
        `configSchema for module '${manifest.id}'`,
      );
      assertPlainJsonSchema(
        def.secretsSchema,
        `secretsSchema for module '${manifest.id}'`,
      );
      configSchema = def.configSchema;
      secretsSchema = def.secretsSchema;

      this.factories.set(manifest.id, {
        type: manifest.type,
        configSchema,
        secretsSchema,
        instantiate: def.instantiate,
      });
      this.manifests.set(manifest.id, {
        id: manifest.id,
        name: manifest.name,
        summary: normalizeSummary(manifest.summary),
        description: manifest.description,
        type: manifest.type,
        version: manifest.version,
        isBuiltin: false,
        configSchema,
        secretsSchema,
      });
    } catch (err) {
      await fs.rm(installDir, { recursive: true, force: true }).catch(() => {});
      this.factories.delete(manifest.id);
      this.manifests.delete(manifest.id);
      throw new HttpError(
        500,
        `Failed to register module '${manifest.id}': ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    }

    try {
      await db.insert(modulesTable).values({
        id: manifest.id,
        name: manifest.name,
        summary: normalizeSummary(manifest.summary),
        description: manifest.description,
        type: manifest.type,
        hash: archiveHash,
        version: manifest.version,
        source: "",
        enabled: false,
        missing: false,
      });
    } catch {
      await fs.rm(installDir, { recursive: true, force: true }).catch(() => {});
      this.factories.delete(manifest.id);
      this.manifests.delete(manifest.id);
      throw new HttpError(
        500,
        `Failed to persist module '${manifest.id}' in database.`,
      );
    }

    return {
      id: manifest.id,
      name: manifest.name,
      summary: normalizeSummary(manifest.summary),
      description: manifest.description,
      type: manifest.type,
      hash: archiveHash,
      version: manifest.version,
      source: "",
      isBuiltin: false,
      enabled: false,
      missing: false,
      hasIcon: false,
      configSchema,
      secretsSchema,
    };
  }

  async installModuleFromRegistry(
    source: string,
    version?: string,
  ): Promise<ModuleManifestRecord> {
    if (!this.modulesPath) {
      throw new HttpError(503, "ModuleService has not been initialized.");
    }

    const { resolveModuleRegistry } = await import("@/utils/registry.util");
    const registry = await resolveModuleRegistry(source, version);
    this.assertEngineCompatibility(registry.engines, `Module '${source}'`);

    const buffer = await downloadBinary(
      registry.downloadUrl,
      MODULE_DOWNLOAD_MAX_BYTES,
    );
    const archiveHash = computeBinaryHash(buffer);

    if (registry.hash && archiveHash !== registry.hash) {
      throw new HttpError(
        400,
        "Archive content hash does not match registry metadata hash.",
      );
    }

    const { manifest, tmpDir } = await this.extractModuleArchive(buffer);
    this.assertEngineCompatibility(manifest.engines, `Module '${manifest.id}'`);
    if (manifest.version !== registry.version) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new HttpError(
        400,
        `Module manifest version '${manifest.version}' does not match registry version '${registry.version}'.`,
      );
    }

    if (this.factories.has(manifest.id)) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new HttpError(
        409,
        `Module '${manifest.id}' is already registered.`,
      );
    }
    const [existing] = await db
      .select({ id: modulesTable.id })
      .from(modulesTable)
      .where(eq(modulesTable.id, manifest.id))
      .limit(1);
    if (existing) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new HttpError(409, `Module '${manifest.id}' already exists.`);
    }

    const modulesPath = this.modulesPath as string;
    const installDir = join(modulesPath, manifest.id);
    try {
      await fs.rename(tmpDir, installDir);
    } catch {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new HttpError(500, `Failed to install module '${manifest.id}'.`);
    }

    let configSchema: JSONSchema;
    let secretsSchema: JSONSchema;

    try {
      const imported = (await this.importModuleExport(
        installDir,
        manifest.main,
        archiveHash,
      )) as {
        default: ModuleExport;
      };
      const def = imported.default;
      assertPlainJsonSchema(
        def.configSchema,
        `configSchema for module '${manifest.id}'`,
      );
      assertPlainJsonSchema(
        def.secretsSchema,
        `secretsSchema for module '${manifest.id}'`,
      );
      configSchema = def.configSchema;
      secretsSchema = def.secretsSchema;

      this.factories.set(manifest.id, {
        type: manifest.type,
        configSchema,
        secretsSchema,
        instantiate: def.instantiate,
      });
      this.manifests.set(manifest.id, {
        id: manifest.id,
        name: manifest.name,
        summary: normalizeSummary(manifest.summary),
        description: manifest.description,
        type: manifest.type,
        version: manifest.version,
        isBuiltin: false,
        configSchema,
        secretsSchema,
      });
    } catch (err) {
      await fs.rm(installDir, { recursive: true, force: true }).catch(() => {});
      this.factories.delete(manifest.id);
      this.manifests.delete(manifest.id);
      throw new HttpError(
        500,
        `Failed to register module '${manifest.id}': ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    }

    const icon = registry.icon
      ? await fetchAndValidateIcon(registry.icon, "module", manifest.id)
      : null;

    try {
      await db.insert(modulesTable).values({
        id: manifest.id,
        name: manifest.name,
        summary: normalizeSummary(manifest.summary),
        description: manifest.description,
        type: manifest.type,
        hash: archiveHash,
        version: manifest.version,
        source: source,
        enabled: false,
        missing: false,
        iconData: icon?.data ?? null,
        iconMime: icon?.mime ?? null,
        iconHash: icon?.hash ?? null,
      });
    } catch {
      await fs.rm(installDir, { recursive: true, force: true }).catch(() => {});
      this.factories.delete(manifest.id);
      this.manifests.delete(manifest.id);
      throw new HttpError(
        500,
        `Failed to persist module '${manifest.id}' in database.`,
      );
    }

    return {
      id: manifest.id,
      name: manifest.name,
      summary: normalizeSummary(manifest.summary),
      description: manifest.description,
      type: manifest.type,
      hash: archiveHash,
      version: manifest.version,
      source: source,
      isBuiltin: false,
      enabled: false,
      missing: false,
      hasIcon: icon !== null,
      configSchema,
      secretsSchema,
    };
  }

  async updateModule(id: string): Promise<{ updated: boolean }> {
    if (!this.modulesPath) {
      throw new HttpError(503, "ModuleService has not been initialized.");
    }

    const [row] = await db
      .select({
        hash: modulesTable.hash,
        version: modulesTable.version,
        source: modulesTable.source,
        type: modulesTable.type,
        iconHash: modulesTable.iconHash,
      })
      .from(modulesTable)
      .where(eq(modulesTable.id, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, `Failed to load module '${id}'.`);
      });

    if (!row) throw new HttpError(404, `Module '${id}' not found.`);
    if (!row.source)
      throw new HttpError(
        409,
        `Module '${id}' has no stored install source and cannot be updated automatically. Only registry-installed modules can be updated.`,
      );

    let registry: {
      version: string;
      downloadUrl: string;
      hash?: string;
      icon?: { url: string; hash: string };
      engines?: { cyrnel?: string };
    };
    try {
      const { resolveModuleRegistry } = await import("@/utils/registry.util");
      registry = await resolveModuleRegistry(row.source);
      this.assertEngineCompatibility(registry.engines, `Module '${id}'`);
    } catch (err) {
      if (err instanceof HttpError) {
        throw new HttpError(
          err.statusCode,
          `Module '${id}' registry source error: ${err.message}. Use PATCH to update with a direct download URL, or reinstall from a registry first.`,
        );
      }
      throw new HttpError(
        502,
        `Module '${id}' registry source is unreachable. Use PATCH to update with a direct download URL, or reinstall from a registry first.`,
      );
    }

    const iconColumns = await resolveIconUpdate(
      registry.icon,
      row.iconHash,
      "module",
      id,
    );

    if (
      registry.hash &&
      registry.hash === row.hash &&
      registry.version === row.version
    ) {
      await this.persistModuleIcon(id, iconColumns);
      return { updated: false };
    }

    const buffer = await downloadBinary(
      registry.downloadUrl,
      MODULE_DOWNLOAD_MAX_BYTES,
    );
    const newHash = computeBinaryHash(buffer);

    if (newHash === row.hash) {
      await this.persistModuleIcon(id, iconColumns);
      return { updated: false };
    }

    const { manifest, tmpDir } = await this.extractModuleArchive(buffer);
    this.assertEngineCompatibility(manifest.engines, `Module '${manifest.id}'`);
    if (manifest.version !== registry.version) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new HttpError(
        400,
        `Module manifest version '${manifest.version}' does not match registry version '${registry.version}'.`,
      );
    }

    if (manifest.id !== id) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new HttpError(
        400,
        `Module manifest id '${manifest.id}' does not match requested id '${id}'.`,
      );
    }
    if (manifest.type !== row.type) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new HttpError(
        400,
        `Module manifest type '${manifest.type}' does not match existing type '${row.type}'.`,
      );
    }

    const modulesPath = this.modulesPath as string;
    const installDir = join(modulesPath, manifest.id);
    const backupDir = `${installDir}.bak`;
    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});

    try {
      await fs.rename(installDir, backupDir);
    } catch {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new HttpError(
        500,
        `Failed to back up existing module '${manifest.id}'.`,
      );
    }

    try {
      await fs.rename(tmpDir, installDir);
    } catch {
      await fs.rename(backupDir, installDir).catch(() => {});
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new HttpError(
        500,
        `Failed to install updated module '${manifest.id}'.`,
      );
    }

    const prevFactory = this.factories.get(manifest.id);
    const prevManifest = this.manifests.get(manifest.id);

    try {
      const imported = (await this.importModuleExport(
        installDir,
        manifest.main,
        newHash,
      )) as {
        default: ModuleExport;
      };
      const def = imported.default;
      assertPlainJsonSchema(
        def.configSchema,
        `configSchema for module '${manifest.id}'`,
      );
      assertPlainJsonSchema(
        def.secretsSchema,
        `secretsSchema for module '${manifest.id}'`,
      );

      this.factories.set(manifest.id, {
        type: manifest.type,
        configSchema: def.configSchema,
        secretsSchema: def.secretsSchema,
        instantiate: def.instantiate,
      });
      this.manifests.set(manifest.id, {
        id: manifest.id,
        name: manifest.name,
        summary: normalizeSummary(manifest.summary),
        description: manifest.description,
        type: manifest.type,
        version: manifest.version,
        isBuiltin: false,
        configSchema: def.configSchema,
        secretsSchema: def.secretsSchema,
      });
    } catch (err) {
      await fs.rm(installDir, { recursive: true, force: true }).catch(() => {});
      await fs.rename(backupDir, installDir).catch(() => {});
      if (prevFactory) this.factories.set(manifest.id, prevFactory);
      else this.factories.delete(manifest.id);
      if (prevManifest) this.manifests.set(manifest.id, prevManifest);
      else this.manifests.delete(manifest.id);
      throw new HttpError(
        500,
        `Failed to register updated module '${manifest.id}': ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    }

    try {
      await db
        .update(modulesTable)
        .set({
          name: manifest.name,
          summary: normalizeSummary(manifest.summary),
          description: manifest.description,
          hash: newHash,
          version: manifest.version,
          ...(iconColumns ?? {}),
        })
        .where(eq(modulesTable.id, id));
    } catch {
      await fs.rm(installDir, { recursive: true, force: true }).catch(() => {});
      await fs.rename(backupDir, installDir).catch(() => {});
      if (prevFactory) this.factories.set(manifest.id, prevFactory);
      else this.factories.delete(manifest.id);
      if (prevManifest) this.manifests.set(manifest.id, prevManifest);
      else this.manifests.delete(manifest.id);
      throw new HttpError(
        500,
        `Failed to persist updated module '${id}' in database.`,
      );
    }

    try {
      const { updated, failed } = await this.regenerateAdapterServices(id);
      if (failed > 0) {
        logger.warn(
          {
            event: "services-regeneration-partial",
            moduleId: id,
            updated,
            failed,
          },
          "Some services failed to regenerate after module update and have been marked stale",
        );
      }
    } catch (err) {
      logger.warn(
        { event: "services-regeneration-failed", err, moduleId: id },
        "Failed to regenerate services after module update",
      );
    }

    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});

    try {
      await this.reloadIfActive(id);
    } catch (err) {
      logger.warn(
        { event: "module-reload-failed", err, moduleId: id },
        "Failed to reload active module after update",
      );
    }

    return { updated: true };
  }

  async patchModule(id: string, url: string): Promise<{ updated: boolean }> {
    if (!this.modulesPath) {
      throw new HttpError(503, "ModuleService has not been initialized.");
    }

    const [row] = await db
      .select({
        hash: modulesTable.hash,
        version: modulesTable.version,
        type: modulesTable.type,
      })
      .from(modulesTable)
      .where(eq(modulesTable.id, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, `Failed to load module '${id}'.`);
      });

    if (!row) throw new HttpError(404, `Module '${id}' not found.`);

    const buffer = await downloadBinary(url, MODULE_DOWNLOAD_MAX_BYTES);
    const newHash = computeBinaryHash(buffer);

    if (newHash === row.hash) {
      return { updated: false };
    }

    const { manifest, tmpDir } = await this.extractModuleArchive(buffer);

    if (manifest.id !== id) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new HttpError(
        400,
        `Module manifest id '${manifest.id}' does not match requested id '${id}'.`,
      );
    }
    if (manifest.type !== row.type) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new HttpError(
        400,
        `Module manifest type '${manifest.type}' does not match existing type '${row.type}'.`,
      );
    }

    const modulesPath = this.modulesPath as string;
    const installDir = join(modulesPath, manifest.id);
    const backupDir = `${installDir}.bak`;
    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});

    try {
      await fs.rename(installDir, backupDir);
    } catch {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new HttpError(
        500,
        `Failed to back up existing module '${manifest.id}'.`,
      );
    }

    try {
      await fs.rename(tmpDir, installDir);
    } catch {
      await fs.rename(backupDir, installDir).catch(() => {});
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new HttpError(
        500,
        `Failed to install updated module '${manifest.id}'.`,
      );
    }

    const prevFactory = this.factories.get(manifest.id);
    const prevManifest = this.manifests.get(manifest.id);

    try {
      const imported = (await this.importModuleExport(
        installDir,
        manifest.main,
        newHash,
      )) as {
        default: ModuleExport;
      };
      const def = imported.default;
      assertPlainJsonSchema(
        def.configSchema,
        `configSchema for module '${manifest.id}'`,
      );
      assertPlainJsonSchema(
        def.secretsSchema,
        `secretsSchema for module '${manifest.id}'`,
      );

      this.factories.set(manifest.id, {
        type: manifest.type,
        configSchema: def.configSchema,
        secretsSchema: def.secretsSchema,
        instantiate: def.instantiate,
      });
      this.manifests.set(manifest.id, {
        id: manifest.id,
        name: manifest.name,
        summary: normalizeSummary(manifest.summary),
        description: manifest.description,
        type: manifest.type,
        version: manifest.version,
        isBuiltin: false,
        configSchema: def.configSchema,
        secretsSchema: def.secretsSchema,
      });
    } catch (err) {
      await fs.rm(installDir, { recursive: true, force: true }).catch(() => {});
      await fs.rename(backupDir, installDir).catch(() => {});
      if (prevFactory) this.factories.set(manifest.id, prevFactory);
      else this.factories.delete(manifest.id);
      if (prevManifest) this.manifests.set(manifest.id, prevManifest);
      else this.manifests.delete(manifest.id);
      throw new HttpError(
        500,
        `Failed to register updated module '${manifest.id}': ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    }

    try {
      await db
        .update(modulesTable)
        .set({
          name: manifest.name,
          summary: normalizeSummary(manifest.summary),
          description: manifest.description,
          hash: newHash,
          version: manifest.version,
          source: "",
          iconData: null,
          iconMime: null,
          iconHash: null,
        })
        .where(eq(modulesTable.id, id));
    } catch {
      await fs.rm(installDir, { recursive: true, force: true }).catch(() => {});
      await fs.rename(backupDir, installDir).catch(() => {});
      if (prevFactory) this.factories.set(manifest.id, prevFactory);
      else this.factories.delete(manifest.id);
      if (prevManifest) this.manifests.set(manifest.id, prevManifest);
      else this.manifests.delete(manifest.id);
      throw new HttpError(
        500,
        `Failed to persist updated module '${id}' in database.`,
      );
    }

    try {
      const { updated, failed } = await this.regenerateAdapterServices(id);
      if (failed > 0) {
        logger.warn(
          {
            event: "services-regeneration-partial",
            moduleId: id,
            updated,
            failed,
          },
          "Some services failed to regenerate after module patch and have been marked stale",
        );
      }
    } catch (err) {
      logger.warn(
        { event: "services-regeneration-failed", err, moduleId: id },
        "Failed to regenerate services after module patch",
      );
    }

    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});

    try {
      await this.reloadIfActive(id);
    } catch (err) {
      logger.warn(
        { event: "module-reload-failed", err, moduleId: id },
        "Failed to reload active module after patch",
      );
    }

    return { updated: true };
  }

  async deleteModule(id: string): Promise<void> {
    if (this.isBuiltin(id)) {
      throw new HttpError(
        400,
        `Module '${id}' is a built-in module and cannot be deleted.`,
      );
    }

    const [deleted] = await db
      .delete(modulesTable)
      .where(eq(modulesTable.id, id))
      .returning({ id: modulesTable.id })
      .catch(() => {
        throw new HttpError(
          500,
          `Failed to delete module '${id}' from database.`,
        );
      });

    if (!deleted) {
      throw new HttpError(404, `Module '${id}' not found.`);
    }

    this.factories.delete(id);
    this.manifests.delete(id);

    if (this.adapters.has(id)) {
      await this.deactivateAdapter(id);
    }
    if (this.activeEnvironment?.id === id) {
      this.deactivateEnvironment(id);
    }

    if (this.modulesPath) {
      const moduleDir = join(this.modulesPath, id);
      try {
        await fs.rm(moduleDir, { recursive: true, force: true });
      } catch (err) {
        logger.warn(
          { event: "module-directory-remove-failed", err, moduleId: id },
          "Failed to remove module filesystem directory",
        );
      }
    }
  }

  private async reconcile(): Promise<void> {
    const knownIds = new Set(this.manifests.keys());
    const rows = await db.select().from(modulesTable);
    const dbIds = new Set(rows.map((r) => r.id));

    const toInsert = [...knownIds].filter((id) => !dbIds.has(id));
    const toMarkMissing = rows
      .filter((r) => !knownIds.has(r.id) && !r.missing)
      .map((r) => r.id);
    const toRestore = rows
      .filter((r) => knownIds.has(r.id) && r.missing)
      .map((r) => r.id);
    const toSync = rows.filter((r) => {
      const manifest = this.manifests.get(r.id);
      if (!manifest) return false;
      return (
        manifest.name !== r.name ||
        manifest.summary !== r.summary ||
        manifest.description !== r.description ||
        manifest.version !== r.version
      );
    });

    if (toInsert.length > 0) {
      await db.insert(modulesTable).values(
        toInsert.map((id) => {
          const manifest = this.manifests.get(id);
          if (!manifest) throw new Error(`Manifest '${id}' is not registered.`);
          return {
            id,
            name: manifest.name,
            summary: normalizeSummary(manifest.summary),
            description: manifest.description,
            type: manifest.type,
            version: manifest.version,
            enabled: true,
            missing: false,
          };
        }),
      );
    }

    if (toMarkMissing.length > 0) {
      await db
        .update(modulesTable)
        .set({ missing: true })
        .where(inArray(modulesTable.id, toMarkMissing));
    }

    if (toRestore.length > 0) {
      await db
        .update(modulesTable)
        .set({ missing: false })
        .where(inArray(modulesTable.id, toRestore));
    }

    if (toSync.length > 0) {
      await Promise.all(
        toSync.map((row) => {
          const manifest = this.manifests.get(row.id);
          if (!manifest) return Promise.resolve();
          return db
            .update(modulesTable)
            .set({
              name: manifest.name,
              summary: normalizeSummary(manifest.summary),
              description: manifest.description,
              version: manifest.version,
            })
            .where(eq(modulesTable.id, row.id));
        }),
      );
    }
  }

  private async activateAdapter(id: string): Promise<void> {
    if (this.adapters.has(id)) return;
    const factory = this.requireFactory(id, "adapter");
    const setupCtx = await this.buildSetupContext(id);
    const instance = factory.instantiate() as AdapterModule;
    await instance.setup(setupCtx);
    this.adapters.set(id, instance);
    await this.lifecycle.hydrateAdapter(id);
  }

  private async deactivateAdapter(id: string): Promise<void> {
    const instance = this.adapters.get(id);
    if (!instance) return;
    this.adapters.delete(id);
    try {
      await instance.teardown();
    } catch (err) {
      logger.warn(
        { event: "adapter-teardown-failed", err, adapterId: id },
        "Adapter teardown failed",
      );
    }
  }

  private async activateEnvironment(id: string): Promise<void> {
    if (this.activeEnvironment?.id === id) return;

    const factory = this.requireFactory(id, "environment");
    const setupCtx = await this.buildSetupContext(id);
    const module = factory.instantiate() as EnvironmentModule;
    await module.setup({ ...setupCtx, bindings: this.bindings });

    const next: EnvironmentInstance = {
      id,
      module,
      executions: new Set(),
      drained: null,
      drain: null,
      disposed: null,
    };

    const previous = this.activeEnvironment;
    this.activeEnvironment = next;
    if (previous) this.markDraining(previous);
  }

  private async regenerateAdapterServices(
    id: string,
  ): Promise<{ updated: number; failed: number }> {
    const factory = this.factories.get(id);
    if (factory?.type !== "adapter") {
      return { updated: 0, failed: 0 };
    }

    const rows = await db
      .select({
        id: servicesTable.id,
        definitionContent: servicesTable.definitionContent,
      })
      .from(servicesTable)
      .where(eq(servicesTable.adapter, id))
      .catch(() => []);

    if (rows.length === 0) return { updated: 0, failed: 0 };

    const setupCtx = await this.buildSetupContext(id);
    const adapter = factory.instantiate() as AdapterModule;
    await adapter.setup(setupCtx);

    let updated = 0;
    let failed = 0;

    try {
      for (const service of rows) {
        if (!service.definitionContent) {
          await db
            .update(servicesTable)
            .set({ stale: true })
            .where(eq(servicesTable.id, service.id))
            .catch(() => {});
          failed++;
          continue;
        }

        try {
          const def = await adapter.generateDefinition(
            service.definitionContent,
          );

          for (const tool of def.tools) {
            if (!IDENTIFIER_SCHEMA.safeParse(tool.id).success) {
              throw new Error(
                `Tool id '${tool.id}' is not a valid identifier.`,
              );
            }
          }

          await db.transaction(async (tx) => {
            const existingTools = await tx
              .select({ id: toolsTable.id, enabled: toolsTable.enabled })
              .from(toolsTable)
              .where(eq(toolsTable.serviceId, service.id));

            const enabledMap = new Map(
              existingTools.map((t) => [t.id, t.enabled]),
            );

            await tx
              .update(servicesTable)
              .set({
                ...def,
                summary: normalizeSummary(def.summary),
                stale: false,
              })
              .where(eq(servicesTable.id, service.id));

            await tx
              .delete(toolsTable)
              .where(eq(toolsTable.serviceId, service.id));

            if (def.tools.length) {
              await tx.insert(toolsTable).values(
                def.tools.map((tool) => ({
                  ...tool,
                  summary: normalizeSummary(tool.summary),
                  serviceId: service.id,
                  enabled: enabledMap.get(tool.id) ?? false,
                })),
              );
            }
          });

          updated++;
        } catch (err) {
          await db
            .update(servicesTable)
            .set({ stale: true })
            .where(eq(servicesTable.id, service.id))
            .catch(() => {});
          logger.warn(
            {
              event: "service-regeneration-failed",
              err,
              serviceId: service.id,
            },
            "Failed to regenerate service after module update",
          );
          failed++;
        }
      }
    } finally {
      await adapter.teardown().catch(() => {});
    }

    logger.info(
      {
        event: "service-regeneration-complete",
        moduleId: id,
        updated,
        failed,
      },
      "Adapter service regeneration complete",
    );
    return { updated, failed };
  }

  private async reloadIfActive(id: string): Promise<void> {
    const factory = this.factories.get(id);
    if (!factory) return;

    if (factory.type === "adapter") {
      const previous = this.adapters.get(id);
      if (!previous) return;

      const setupCtx = await this.buildSetupContext(id);
      const next = factory.instantiate() as AdapterModule;
      await next.setup(setupCtx);
      this.adapters.set(id, next);
      try {
        await this.lifecycle.hydrateAdapter(id);
      } catch (err) {
        this.adapters.set(id, previous);
        try {
          await next.teardown();
        } catch (teardownErr) {
          logger.warn(
            {
              event: "adapter-teardown-failed",
              err: teardownErr,
              adapterId: id,
            },
            "Adapter teardown failed",
          );
        }
        throw err;
      }
      try {
        await previous.teardown();
      } catch (err) {
        logger.warn(
          { event: "adapter-teardown-failed", err, adapterId: id },
          "Adapter teardown failed",
        );
      }
      return;
    }

    if (this.activeEnvironment?.id !== id) return;
    const factoryEnv = this.requireFactory(id, "environment");
    const setupCtx = await this.buildSetupContext(id);
    const module = factoryEnv.instantiate() as EnvironmentModule;
    await module.setup({ ...setupCtx, bindings: this.bindings });

    const next: EnvironmentInstance = {
      id,
      module,
      executions: new Set(),
      drained: null,
      drain: null,
      disposed: null,
    };
    const previous = this.activeEnvironment;
    this.activeEnvironment = next;
    if (previous) this.markDraining(previous);
  }

  private async buildSetupContext(id: string): Promise<ModuleSetupContext> {
    const { config, secrets } = await this.assertConfigAndSecretsValid(id);
    return { config, secrets };
  }

  private async loadSecrets(id: string): Promise<Record<string, unknown>> {
    const [row] = await db
      .select({ payload: moduleSecrets.payload })
      .from(moduleSecrets)
      .where(eq(moduleSecrets.moduleId, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, `Failed to load secrets for module '${id}'.`);
      });

    if (!row?.payload) return {};

    const parsed = encryptedSecretsSchema.safeParse(row.payload);
    if (!parsed.success)
      throw new HttpError(500, "Stored secrets payload is malformed.");

    return decryptAndMaybeReEncrypt(
      parsed.data,
      async (reEncrypted) => {
        await db
          .update(moduleSecrets)
          .set({ payload: reEncrypted, updatedAt: Date.now() })
          .where(eq(moduleSecrets.moduleId, id));
      },
      { moduleId: id },
    );
  }

  private async assertConfigAndSecretsValid(
    id: string,
  ): Promise<ValidatedSetupValues> {
    const manifest = this.requireRegistered(id);
    const [config, secrets] = await Promise.all([
      this.getConfig(id),
      this.loadSecrets(id),
    ]);
    const validatedConfig = isNullOnlySchema(manifest.configSchema)
      ? config
      : applyJsonSchemaDefaults(
          manifest.configSchema,
          // Conformant projection: validates identically to the
          // declared-only projection (permitted keys are unconstrained)
          // while delivering schema-permitted keys to the module.
          filterPayloadToSchema(manifest.configSchema, config, {
            keepPermitted: true,
          }),
          `Invalid configuration for module '${id}'.`,
        );

    const validatedSecrets = isNullOnlySchema(manifest.secretsSchema)
      ? secrets
      : applyJsonSchemaDefaults(
          manifest.secretsSchema,
          filterPayloadToSchema(manifest.secretsSchema, secrets, {
            keepPermitted: true,
          }),
          `Invalid secrets for module '${id}'.`,
        );

    return {
      config: validatedConfig,
      secrets: validatedSecrets,
    };
  }

  private requireRegistered(id: string): RegisteredModule {
    const manifest = this.manifests.get(id);
    if (!manifest) {
      throw new HttpError(404, `Module '${id}' is not registered.`);
    }
    return manifest;
  }

  private deactivateEnvironment(id: string): void {
    if (this.activeEnvironment?.id !== id) return;
    const current = this.activeEnvironment;
    this.activeEnvironment = null;
    this.markDraining(current);
  }

  private markDraining(instance: EnvironmentInstance): void {
    if (instance.drained) return;
    this.drainingEnvironments.add(instance);

    let drain!: () => void;
    instance.drained = new Promise<void>((resolve) => {
      drain = resolve;
    });
    instance.drain = drain;

    if (instance.executions.size === 0) {
      drain();
    }

    instance.disposed = this.dispose(instance);
  }

  private async dispose(instance: EnvironmentInstance): Promise<void> {
    await instance.drained;
    this.drainingEnvironments.delete(instance);
    try {
      await instance.module.teardown();
    } catch (err) {
      logger.warn(
        {
          event: "environment-teardown-failed",
          err,
          environmentId: instance.id,
        },
        "Environment teardown failed",
      );
    }
  }

  private requireActiveEnvironment(): EnvironmentInstance {
    if (!this.activeEnvironment) {
      throw new HttpError(503, "No environment module is active.");
    }
    return this.activeEnvironment;
  }

  private requireAdapter(id: string): AdapterModule {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new HttpError(503, `Adapter '${id}' is not active.`);
    }
    return adapter;
  }

  private async invokeAdapterWithTimeout(
    adapterId: string,
    input: InvokeInput,
  ): Promise<unknown> {
    const timeoutMs =
      Number(process.env.CYRNEL_INVOKE_TIMEOUT_MS) || DEFAULT_INVOKE_TIMEOUT_MS;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    try {
      return await Promise.race([
        this.requireAdapter(adapterId).invoke(input),
        new Promise<never>((_resolve, reject) => {
          timeoutHandle = setTimeout(
            () =>
              reject(
                new HttpError(
                  504,
                  `Tool invocation timed out after ${timeoutMs}ms.`,
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private requireFactory(id: string, type: ModuleType): ModuleFactory {
    const factory = this.factories.get(id);
    if (!factory) {
      throw new HttpError(404, `Module '${id}' is not registered.`);
    }
    if (factory.type !== type) {
      throw new HttpError(
        409,
        `Module '${id}' has type '${factory.type}', expected '${type}'.`,
      );
    }
    return factory;
  }

  private async extractModuleArchive(
    buffer: Uint8Array,
  ): Promise<{ manifest: ModuleManifestSchema; tmpDir: string }> {
    if (!this.modulesPath) {
      throw new HttpError(503, "ModuleService has not been initialized.");
    }

    const decompressed = zstdDecompress(new Uint8Array(buffer));

    const tmpDir = await fs.mkdtemp(join(this.modulesPath, ".install-"));

    try {
      const { Readable } = await import("node:stream");
      const { pipeline } = await import("node:stream/promises");

      const readable = Readable.from([Buffer.from(decompressed)]);
      const unpack = new Unpack({ cwd: tmpDir });
      await pipeline(readable, unpack);

      const moduleJsonPath = join(tmpDir, "module.json");
      let rawManifest: string;
      try {
        rawManifest = await fs.readFile(moduleJsonPath, "utf8");
      } catch {
        throw new HttpError(
          400,
          "Archive must contain a 'module.json' at its root.",
        );
      }

      let parsedManifest: Record<string, unknown>;
      try {
        parsedManifest = JSON.parse(rawManifest) as Record<string, unknown>;
      } catch {
        throw new HttpError(400, "module.json contains invalid JSON.");
      }

      const parsed = moduleManifestSchema.safeParse(parsedManifest);
      if (!parsed.success) {
        throw new HttpError(
          400,
          `Invalid module manifest: ${parsed.error.message}`,
        );
      }
      const manifest = parsed.data;

      const mainPath = resolve(tmpDir, manifest.main);
      if (!mainPath.startsWith(tmpDir + sep)) {
        throw new HttpError(
          400,
          "Manifest 'main' must point to a file inside the archive.",
        );
      }
      try {
        const mainStat = await fs.stat(mainPath);
        if (!mainStat.isFile()) {
          throw new HttpError(
            400,
            "Manifest 'main' must point to a valid file.",
          );
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(
          400,
          `Manifest 'main' file '${manifest.main}' not found in archive.`,
        );
      }

      return { manifest, tmpDir };
    } catch (err) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  private registerBuiltinModules(): void {
    const builtins: {
      id: string;
      name: string;
      summary: string;
      description: string;
      type: ModuleType;
      version: string;
      configSchema: JSONSchema;
      secretsSchema: JSONSchema;
      instantiate: () => Module;
    }[] = [
      {
        id: "openapi",
        name: "OpenAPI Adapter",
        summary: "Import HTTP APIs from OpenAPI documents",
        description: "Adapter for interacting with OpenAPI services",
        type: "adapter",
        version: "1.0.0",
        ...oapi,
      },
      {
        id: "typescript-ivm",
        name: "Typescript Isolated VM",
        summary: "Run self-contained TypeScript code",
        description: "TypeScript environment powered by isolated-vm",
        type: "environment",
        version: "1.0.0",
        ...tsivm,
      },
    ];

    for (const {
      id,
      name,
      summary,
      description,
      type,
      version,
      configSchema,
      secretsSchema,
      instantiate,
    } of builtins) {
      this.factories.set(id, {
        type,
        configSchema,
        secretsSchema,
        instantiate,
      });
      this.manifests.set(id, {
        id,
        name,
        summary,
        description,
        type,
        version,
        isBuiltin: true,
        configSchema,
        secretsSchema,
      });
    }
  }

  private async registerCustomModules(path: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(path, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const dir = join(path, entry.name);
      const manifestPath = join(dir, "module.json");

      let raw: string;
      try {
        raw = await fs.readFile(manifestPath, "utf8");
      } catch {
        continue;
      }

      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new HttpError(
          500,
          `Invalid JSON in module manifest at '${manifestPath}'.`,
        );
      }

      const parsed = moduleManifestSchema.safeParse(manifest);
      if (!parsed.success) {
        throw new HttpError(
          500,
          `Invalid module manifest at '${manifestPath}': ${parsed.error.message}`,
        );
      }

      const { id, name, summary, description, type, version, main, engines } =
        parsed.data;
      this.assertEngineCompatibility(engines, `Module '${id}'`);

      if (this.factories.has(id)) {
        throw new HttpError(
          409,
          `Duplicate module id '${id}' at '${manifestPath}'.`,
        );
      }

      const dirRoot = resolve(dir);
      const mainPath = resolve(dirRoot, main);
      if (mainPath !== dirRoot && !mainPath.startsWith(dirRoot + sep)) {
        throw new HttpError(
          500,
          `Module '${id}' at '${manifestPath}' has 'main' that resolves outside module directory.`,
        );
      }

      const imported = (await this.importModuleExport(
        dirRoot,
        main,
        version,
      )) as { default: ModuleExport };
      const { configSchema, secretsSchema, instantiate } = imported.default;
      assertPlainJsonSchema(configSchema, `configSchema for module '${id}'`);
      assertPlainJsonSchema(secretsSchema, `secretsSchema for module '${id}'`);

      this.factories.set(id, {
        type,
        configSchema,
        secretsSchema,
        instantiate,
      });
      this.manifests.set(id, {
        id,
        name,
        summary: normalizeSummary(summary),
        description,
        type,
        version,
        isBuiltin: false,
        configSchema,
        secretsSchema,
      });
    }
  }

  private async importModuleExport(
    root: string,
    main: string,
    cacheKey: string,
  ): Promise<unknown> {
    const mainPath = resolve(root, main);
    return import(
      `${pathToFileURL(mainPath).href}?v=${encodeURIComponent(cacheKey)}`
    );
  }

  private assertEngineCompatibility(
    engines: { cyrnel?: string } | undefined,
    label: string,
  ): void {
    const range = engines?.cyrnel?.trim();
    if (!range) return;
    if (!satisfies(CYRNEL_CORE_VERSION, range)) {
      throw new HttpError(
        400,
        `${label} requires Cyrnel '${range}', but this server is '${CYRNEL_CORE_VERSION}'.`,
      );
    }
  }

  private isBuiltin(id: string): boolean {
    return this.manifests.get(id)?.isBuiltin ?? false;
  }

  private async persistModuleIcon(
    id: string,
    iconColumns: IconColumns | undefined,
  ): Promise<void> {
    if (!iconColumns) return;
    await db
      .update(modulesTable)
      .set(iconColumns)
      .where(eq(modulesTable.id, id))
      .catch(() => {
        throw new HttpError(500, `Failed to update icon for module '${id}'.`);
      });
  }

  private toListRecord(
    row: Omit<ModuleRecord, "iconData" | "iconMime">,
  ): ListModuleManifestResult {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      summary: row.summary,
      description: row.description,
      version: row.version,
      isBuiltin: this.isBuiltin(row.id),
      enabled: row.enabled,
      missing: row.missing,
      hasIcon: row.iconHash !== null,
    };
  }

  private toManifestRecord(
    row: Omit<ModuleRecord, "iconData" | "iconMime">,
  ): GetModuleManifestResult {
    const manifest = this.manifests.get(row.id);
    return {
      ...this.toListRecord(row),
      hash: row.hash,
      version: row.version,
      source: row.source,
      configSchema: manifest?.configSchema ?? EMPTY_OBJECT_SCHEMA,
      secretsSchema: manifest?.secretsSchema ?? EMPTY_OBJECT_SCHEMA,
    };
  }
}
