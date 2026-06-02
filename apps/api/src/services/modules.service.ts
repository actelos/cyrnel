import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import * as oapi from "@mci/openapi";
import type {
  AdapterModule,
  EnvironmentBindings,
  EnvironmentModule,
  ExecutionExitState,
  ExecutionInput,
  InvokeInput,
  Module,
  ServiceDefinition,
  ServiceState,
  ToolDocsInput,
} from "@mci/sdk";
import * as tsivm from "@mci/typescript-ivm";
import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import {
  type ModuleRecord,
  modules as modulesTable,
  services as servicesTable,
  tools as toolsTable,
} from "@/db/schema";
import { logger } from "@/logger";
import { HttpError } from "@/models/error.model";
import type {
  FilterModuleManifestInput,
  GenerateDefinitionInput,
  ModuleManifestRecord,
  ModuleType,
  SetModuleEnabledInput,
} from "@/models/modules.model";

interface ModuleFactory {
  type: ModuleType;
  instantiate(): Module;
}

interface AdapterLifecycle {
  hydrateAdapter(adapterId: string): Promise<void>;
}

interface RegisteredModule {
  id: string;
  name: string;
  description: string;
  type: ModuleType;
  isBuiltin: boolean;
}

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
    const active = stateRows.filter((r) => r.enabled && !r.orphaned);

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
              { err, environmentId: instance.id, eid },
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
          logger.warn({ err, adapterId: id }, "Adapter teardown failed");
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
        toolEnabled: toolsTable.enabled,
      })
      .from(servicesTable)
      .leftJoin(
        toolsTable,
        and(
          eq(toolsTable.serviceId, servicesTable.id),
          eq(toolsTable.name, input.toolId),
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

    if (!row.serviceEnabled) {
      throw new HttpError(409, `Service '${input.serviceId}' is disabled.`);
    }

    if (!row.toolEnabled) {
      throw new HttpError(
        409,
        `Tool '${input.toolId}' in service '${input.serviceId}' is disabled.`,
      );
    }

    return this.requireAdapter(row.adapter).invoke(input);
  }

  async list(
    filters: FilterModuleManifestInput = {},
  ): Promise<ModuleManifestRecord[]> {
    const conditions = [];
    if (filters.type !== undefined) {
      conditions.push(eq(modulesTable.type, filters.type));
    }
    if (filters.enabled !== undefined && filters.enabled !== null) {
      conditions.push(eq(modulesTable.enabled, filters.enabled));
    }

    const rows = await db
      .select()
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
          ? `${row.name}\n${row.description}`.toLowerCase().includes(query)
          : true,
      )
      .map((row) => this.toManifestRecord(row));
  }

  async get(id: string): Promise<ModuleManifestRecord | undefined> {
    const [row] = await db
      .select()
      .from(modulesTable)
      .where(eq(modulesTable.id, id))
      .limit(1);

    return row ? this.toManifestRecord(row) : undefined;
  }

  async setEnabled(input: SetModuleEnabledInput): Promise<void> {
    const [row] = await db
      .select()
      .from(modulesTable)
      .where(eq(modulesTable.id, input.id))
      .limit(1);

    if (!row) throw new HttpError(404, `Module '${input.id}' not found.`);

    if (input.enabled && row.orphaned) {
      throw new HttpError(
        409,
        `Module '${input.id}' is orphaned and cannot be enabled.`,
      );
    }

    if (row.enabled === input.enabled) return;

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

  async reload(): Promise<null> {
    if (this.modulesPath === null) {
      throw new HttpError(503, "ModuleService has not been initialized.");
    }

    this.factories.clear();
    this.manifests.clear();
    this.registerBuiltinModules();
    await this.registerCustomModules(this.modulesPath);
    await this.reconcile();

    const orphanedAdapters = [...this.adapters.keys()].filter(
      (id) => !this.factories.has(id),
    );
    await Promise.all(orphanedAdapters.map((id) => this.deactivateAdapter(id)));

    if (
      this.activeEnvironment &&
      !this.factories.has(this.activeEnvironment.id)
    ) {
      this.deactivateEnvironment(this.activeEnvironment.id);
    }

    return null;
  }

  private async reconcile(): Promise<void> {
    const knownIds = new Set(this.manifests.keys());
    const rows = await db.select().from(modulesTable);
    const dbIds = new Set(rows.map((r) => r.id));

    const toInsert = [...knownIds].filter((id) => !dbIds.has(id));
    const toOrphan = rows
      .filter((r) => !knownIds.has(r.id) && !r.orphaned)
      .map((r) => r.id);
    const toRestore = rows
      .filter((r) => knownIds.has(r.id) && r.orphaned)
      .map((r) => r.id);

    if (toInsert.length > 0) {
      await db.insert(modulesTable).values(
        toInsert.map((id) => {
          const manifest = this.manifests.get(id);
          if (!manifest) throw new Error(`Manifest '${id}' is not registered.`);
          return {
            id,
            name: manifest.name,
            description: manifest.description,
            type: manifest.type,
            enabled: true,
            orphaned: false,
          };
        }),
      );
    }

    if (toOrphan.length > 0) {
      await db
        .update(modulesTable)
        .set({ orphaned: true, enabled: false })
        .where(inArray(modulesTable.id, toOrphan));
    }

    if (toRestore.length > 0) {
      await db
        .update(modulesTable)
        .set({ orphaned: false })
        .where(inArray(modulesTable.id, toRestore));
    }
  }

  private async activateAdapter(id: string): Promise<void> {
    if (this.adapters.has(id)) return;
    const factory = this.requireFactory(id, "adapter");
    const instance = factory.instantiate() as AdapterModule;
    await instance.setup({});
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
      logger.warn({ err, adapterId: id }, "Adapter teardown failed");
    }
  }

  private async activateEnvironment(id: string): Promise<void> {
    if (this.activeEnvironment?.id === id) return;

    const factory = this.requireFactory(id, "environment");
    const module = factory.instantiate() as EnvironmentModule;
    await module.setup({ bindings: this.bindings });

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
        { err, environmentId: instance.id },
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

  private registerBuiltinModules(): void {
    const builtins: {
      manifest: { name: string; description: string; type: ModuleType };
      instantiate: () => Module;
    }[] = [
      { manifest: oapi.manifest, instantiate: oapi.instantiate },
      { manifest: tsivm.manifest, instantiate: tsivm.instantiate },
    ];

    for (const { manifest, instantiate } of builtins) {
      const id = manifest.name;
      this.factories.set(id, {
        type: manifest.type,
        instantiate,
      });
      this.manifests.set(id, {
        id,
        name: manifest.name,
        description: manifest.description,
        type: manifest.type,
        isBuiltin: true,
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

      let manifest: {
        name: string;
        description: string;
        type: ModuleType;
        main: string;
      };
      try {
        manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      } catch (err) {
        logger.warn(
          { err, manifestPath },
          "Skipping module: failed to read or parse module.json",
        );
        continue;
      }

      const id = manifest.name;
      if (this.factories.has(id)) continue;

      const dirRoot = resolve(dir);
      const mainPath = resolve(dirRoot, manifest.main);
      if (mainPath !== dirRoot && !mainPath.startsWith(dirRoot + sep)) {
        logger.warn(
          { manifestPath, main: manifest.main },
          "Skipping module: 'main' resolves outside module directory",
        );
        continue;
      }

      const imported = (await import(mainPath)) as {
        instantiate: () => Module;
      };

      this.factories.set(id, {
        type: manifest.type,
        instantiate: imported.instantiate,
      });
      this.manifests.set(id, {
        id,
        name: manifest.name,
        description: manifest.description,
        type: manifest.type,
        isBuiltin: false,
      });
    }
  }

  private isBuiltin(id: string): boolean {
    return this.manifests.get(id)?.isBuiltin ?? false;
  }

  private toManifestRecord(row: ModuleRecord): ModuleManifestRecord {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      description: row.description,
      isBuiltin: this.isBuiltin(row.id),
      enabled: row.enabled,
      orphaned: row.orphaned,
    };
  }
}
