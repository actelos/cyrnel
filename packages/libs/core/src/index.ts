import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AdapterModule,
  EnvironmentModule,
  EnvironmentSetupContext,
  ExecutionExitState,
  ExecutionOptions,
  ModuleSetupContext,
} from "@mci/sdk";
import { z } from "zod";
import { builtinModules } from "@/builtins";
import type {
  AnyModuleFactory,
  BuiltinModuleManifest,
  CustomModuleManifest,
  ModuleType,
} from "@/model";

export type ModuleManifestResponse =
  | BuiltinModuleManifest
  | CustomModuleManifest;

export type ModuleRegistry = {
  activateAdapter(name: string, context: ModuleSetupContext): Promise<void>;
  deactivateAdapter(name: string): Promise<void>;

  activateEnvironment(
    name: string,
    context: EnvironmentSetupContext,
  ): Promise<void>;
  deactivateEnvironment(name: string): Promise<void>;

  execute(
    eid: number,
    code: string,
    options?: ExecutionOptions,
  ): Promise<ExecutionExitState>;
  kill(eid: number): Promise<void>;

  getManifest(name: string): ModuleManifestResponse | undefined;
  listManifests(filter?: ManifestFilter): ModuleManifestResponse[];
};

export interface ManifestFilter {
  query?: string;
  isBuiltin?: boolean;
  type?: ModuleType;
}

type ManagedEnvironment = {
  name: string;
  module: EnvironmentModule;
  status: "active" | "draining";
  eids: Set<number>;
  drainDone?: Promise<void>;
  resolveDrainDone?: () => void;
};

const ModuleManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  type: z.enum(["adapter", "environment"]),
  main: z.string(),
});

async function readManifest(
  path: string,
): Promise<CustomModuleManifest | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = ModuleManifestSchema.parse(JSON.parse(raw));
    return { ...parsed, isBuiltin: false };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }

    throw new Error(`failed loading manifest ${path}: ${String(error)}`);
  }
}

async function loadModuleFactories(
  modulesDir: string,
): Promise<Map<string, AnyModuleFactory>> {
  const factories = new Map<string, AnyModuleFactory>();

  const addFactory = (factory: AnyModuleFactory) => {
    if (factories.has(factory.manifest.name)) {
      throw new Error(`duplicate manifest name "${factory.manifest.name}"`);
    }
    factories.set(factory.manifest.name, factory);
  };

  for (const builtin of builtinModules) {
    addFactory(builtin);
  }

  const entries = await readdir(modulesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const manifest = await readManifest(
      join(modulesDir, entry.name, "module.json"),
    );

    if (!manifest) continue;

    addFactory({
      manifest,
      instantiate: () => {
        throw new Error(
          `module "${manifest.name}" cannot be instantiated (no factory registered)`,
        );
      },
    });
  }

  return factories;
}

export async function createModuleRegistry(
  modulesDir: string,
): Promise<ModuleRegistry> {
  const factories = await loadModuleFactories(modulesDir);

  const activeAdapters = new Map<string, AdapterModule>();
  const environments: ManagedEnvironment[] = [];
  const executionOwner = new Map<number, EnvironmentModule>();

  const listManifests = (
    filter: ManifestFilter = {},
  ): ModuleManifestResponse[] => {
    const query = filter.query?.trim().toLowerCase();

    return [...factories.values()]
      .map((factory) => factory.manifest)
      .filter((manifest) => {
        if (
          filter.isBuiltin !== undefined &&
          manifest.isBuiltin !== filter.isBuiltin
        ) {
          return false;
        }
        if (filter.type !== undefined && manifest.type !== filter.type) {
          return false;
        }
        if (query) {
          const haystack =
            `${manifest.name}\n${manifest.description}`.toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        return true;
      });
  };

  const activateAdapter = async (name: string, context: ModuleSetupContext) => {
    const factory = factories.get(name);
    if (!factory) throw new Error(`unknown module "${name}"`);
    if (factory.manifest.type !== "adapter") {
      throw new Error(`module "${name}" is not an adapter`);
    }
    if (activeAdapters.has(name)) return;

    const instance = factory.instantiate() as AdapterModule;

    activeAdapters.set(name, instance);
    try {
      await instance.setup?.(context);
    } catch (error) {
      activeAdapters.delete(name);
      throw error;
    }
  };

  const deactivateAdapter = async (name: string) => {
    const adapter = activeAdapters.get(name);
    if (!adapter) return;

    try {
      await adapter.teardown?.();
    } finally {
      activeAdapters.delete(name);
    }
  };

  const getActiveEnvironment = () =>
    environments.find((env) => env.status === "active");

  const findEnvironmentByName = (name: string) =>
    environments.find((env) => env.name === name);

  const beginDraining = (environment: ManagedEnvironment) => {
    if (environment.status === "draining") return;

    let resolveDrainDone: (() => void) | undefined;
    const drainDone = new Promise<void>((resolve) => {
      resolveDrainDone = resolve;
    });

    environment.status = "draining";
    environment.drainDone = drainDone;
    environment.resolveDrainDone = resolveDrainDone;

    if (environment.eids.size === 0) environment.resolveDrainDone?.();
  };

  const finishDraining = async (environment: ManagedEnvironment) => {
    if (environment.status !== "draining") return;
    await environment.drainDone;
    await environment.module.teardown?.();
    const index = environments.indexOf(environment);
    if (index !== -1) environments.splice(index, 1);
  };

  const activateEnvironment = async (
    name: string,
    context: EnvironmentSetupContext,
  ) => {
    const factory = factories.get(name);
    if (!factory) throw new Error(`unknown module "${name}"`);
    if (factory.manifest.type !== "environment") {
      throw new Error(`module "${name}" is not an environment`);
    }

    const activeEnvironment = getActiveEnvironment();
    if (activeEnvironment) {
      if (activeEnvironment.name === name) return;
      throw new Error(`an environment module is already active`);
    }

    const instance = factory.instantiate() as EnvironmentModule;

    const managed: ManagedEnvironment = {
      name,
      module: instance,
      status: "active",
      eids: new Set(),
    };
    environments.push(managed);
    try {
      await instance.setup?.(context);
    } catch (error) {
      const index = environments.indexOf(managed);
      if (index !== -1) environments.splice(index, 1);
      throw error;
    }
  };

  const deactivateEnvironment = async (name: string) => {
    const environment = findEnvironmentByName(name);
    if (!environment) throw new Error(`environment "${name}" is not loaded`);

    beginDraining(environment);
    await finishDraining(environment);
  };

  const execute = async (
    eid: number,
    code: string,
    options: ExecutionOptions = {},
  ): Promise<ExecutionExitState> => {
    const environment = getActiveEnvironment();
    if (!environment) throw new Error(`no environment is active`);
    if (executionOwner.has(eid)) {
      throw new Error(`execution ${eid} is already running`);
    }

    environment.eids.add(eid);
    executionOwner.set(eid, environment.module);

    try {
      return await environment.module.execute({ eid, code, options });
    } finally {
      environment.eids.delete(eid);
      executionOwner.delete(eid);

      if (environment.status === "draining" && environment.eids.size === 0) {
        environment.resolveDrainDone?.();
      }
    }
  };

  const kill = async (eid: number): Promise<void> => {
    const module = executionOwner.get(eid);
    if (!module) return;
    await module.kill(eid);
  };

  return {
    activateAdapter,
    deactivateAdapter,
    activateEnvironment,
    deactivateEnvironment,
    execute,
    kill,
    getManifest: (name) => factories.get(name)?.manifest,
    listManifests,
  };
}
