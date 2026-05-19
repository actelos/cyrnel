import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AdapterModule,
  EnvironmentBindings,
  EnvironmentModule,
  EnvironmentSetupContext,
  Module,
  ModuleSetupContext,
} from "@mci/sdk";
import { z } from "zod";
import { builtinModules } from "@/builtins";
import type {
  ModuleFactory as AnyModuleFactory,
  LoadedManifest,
  ManifestFilter,
  ModuleManifest,
} from "@/model";

type ActivateModule = {
  (name: string, context: ModuleSetupContext): Promise<void>;
  (
    name: string,
    context: Omit<EnvironmentSetupContext, "bindings">,
  ): Promise<void>;
};

export type ModuleRegistry = {
  activate: ActivateModule;
  deactivate(name: string): Promise<void>;
  getManifest(name: string): LoadedManifest | undefined;
  listManifests(filter?: ManifestFilter): LoadedManifest[];
};

export type ModuleRegistryOptions = {
  environmentBindings?: EnvironmentBindings;
};

const ModuleManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  type: z.enum(["adapter", "environment"]),
  main: z.string(),
});

type ModuleFactory<T extends Module = Module> = AnyModuleFactory<T>;

async function readManifest(path: string): Promise<ModuleManifest | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = ModuleManifestSchema.parse(JSON.parse(raw)) as z.infer<
      typeof ModuleManifestSchema
    >;
    return parsed;
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
): Promise<Record<string, ModuleFactory>> {
  const factories = new Map<string, ModuleFactory>();

  const addFactory = (factory: ModuleFactory) => {
    if (factories.has(factory.manifest.name)) {
      throw new Error(`duplicate manifest name "${factory.manifest.name}"`);
    }

    factories.set(factory.manifest.name, factory);
  };

  for (const builtin of builtinModules) {
    addFactory({
      manifest: builtin.manifest,
      instantiate: builtin.instantiate,
    });
  }

  const entries = await readdir(modulesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const manifest = await readManifest(
      join(modulesDir, entry.name, "module.json"),
    );

    if (!manifest) continue;

    addFactory({
      manifest: { ...manifest, isBuiltin: false },
      instantiate: () => {
        throw new Error(
          `module "${manifest.name}" cannot be instantiated (no factory registered)`,
        );
      },
    });
  }

  return Object.fromEntries(factories);
}

export async function createModuleRegistry(
  modulesDir: string,
  options: ModuleRegistryOptions = {},
): Promise<ModuleRegistry> {
  const factories = await loadModuleFactories(modulesDir);
  const activeAdapters = new Map<string, AdapterModule>();
  let activeEnvironment:
    | { name: string; module: EnvironmentModule }
    | undefined;

  const listManifests = (filter: ManifestFilter = {}): LoadedManifest[] => {
    const query = filter.query?.trim().toLowerCase();

    return Object.values(factories)
      .map((factory) => factory.manifest)
      .filter((manifest) => {
        if (
          filter.isBuiltin !== undefined &&
          manifest.isBuiltin !== filter.isBuiltin
        ) {
          return false;
        }
        if (filter.type !== undefined && manifest.type !== filter.type)
          return false;
        if (query) {
          const haystack =
            `${manifest.name}\n${manifest.description}`.toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        return true;
      });
  };

  const activate: ActivateModule = async (name, context) => {
    const factory = factories[name];
    if (!factory) {
      throw new Error(`unknown module "${name}"`);
    }

    const manifest = factory.manifest;

    if (manifest.type === "adapter") {
      const existing = activeAdapters.get(name);
      if (existing) return;

      const instance = factory.instantiate() as AdapterModule;
      if (instance.setup) await instance.setup(context as ModuleSetupContext);
      activeAdapters.set(name, instance);
      return;
    }

    if (manifest.type === "environment") {
      if (activeEnvironment) {
        if (activeEnvironment.name === name) return;
        throw new Error(
          `an environment module is already active; deactivate it first`,
        );
      }

      const instance = factory.instantiate() as EnvironmentModule;
      if (!options.environmentBindings) {
        throw new Error(
          `cannot activate environment module "${name}" (no environment bindings configured)`,
        );
      }

      const setupContext = {
        ...(context as Omit<EnvironmentSetupContext, "bindings">),
        bindings: options.environmentBindings,
      } satisfies EnvironmentSetupContext;

      if (instance.setup) await instance.setup(setupContext);
      activeEnvironment = { name, module: instance };
      return;
    }

    throw new Error(
      `unknown module type "${(manifest as LoadedManifest).type}"`,
    );
  };

  const deactivate = async (name: string) => {
    const adapter = activeAdapters.get(name);
    if (adapter) {
      try {
        if (adapter.teardown) await adapter.teardown();
      } finally {
        activeAdapters.delete(name);
      }
      return;
    }

    if (activeEnvironment?.name === name) {
      try {
        if (activeEnvironment.module.teardown)
          await activeEnvironment.module.teardown();
      } finally {
        activeEnvironment = undefined;
      }
    }
  };

  return {
    getManifest: (name) => factories[name]?.manifest,
    activate,
    deactivate,
    listManifests,
  };
}
