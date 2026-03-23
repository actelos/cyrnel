import { logger } from "@/logger";
import {
  loadModule,
  loadModulesConfig,
  type AdapterModule,
  type EnvironmentModule,
  type ModulesConfig,
} from "@/config/modules";
import {
  createEnvironmentPool,
  type EnvironmentPool,
} from "@/services/pool.service";

export type ModulesState = {
  config: ModulesConfig;
  loaded: {
    environment: Map<string, EnvironmentModule>;
    adapter: Map<string, AdapterModule>;
  };
  errors: Map<string, Error>;
};

export type ServerState = {
  modules: ModulesState;
  pools: {
    environment: EnvironmentPool;
  };
};

export const loadServerState = async (): Promise<ServerState> => {
  let modulesConfig: ModulesConfig;
  try {
    modulesConfig = loadModulesConfig();
  } catch (err) {
    logger.error({ err }, "Failed to load modules config");
    throw new Error("Failed to load modules config", { cause: err });
  }

  const modulesState: ModulesState = {
    config: modulesConfig,
    loaded: {
      environment: new Map(),
      adapter: new Map(),
    },
    errors: new Map(),
  };

  const entries = [
    ...Object.entries(modulesConfig.environment),
    ...Object.entries(modulesConfig.adapter),
  ];

  await Promise.all(
    entries.map(async ([id, config]) => {
      if (!config.enabled) {
        logger.info(
          {
            moduleType: config.type,
            moduleId: id,
            modulePath: config.path,
          },
          "Skipped disabled module",
        );
        return;
      }
      const result = await loadModule(config.path, config.type);
      if (result.error) {
        modulesState.errors.set(`${config.type}.${id}`, result.error);
        logger.error(
          {
            err: result.error,
            moduleType: config.type,
            moduleId: id,
            modulePath: config.path,
          },
          "Failed to load module",
        );
        return;
      }

      if (config.type === "environment") {
        modulesState.loaded.environment.set(
          id,
          result.module as EnvironmentModule,
        );
        return;
      }

      modulesState.loaded.adapter.set(id, result.module as AdapterModule);
    }),
  );

  const enabledEnvironmentCount = Object.values(
    modulesConfig.environment,
  ).filter((config) => config.enabled).length;
  const enabledAdapterCount = Object.values(modulesConfig.adapter).filter(
    (config) => config.enabled,
  ).length;

  if (enabledEnvironmentCount === 0 || enabledAdapterCount === 0) {
    logger.error(
      {
        environmentEnabled: enabledEnvironmentCount,
        adapterEnabled: enabledAdapterCount,
      },
      "Every module type must have at least one enabled module",
    );
    throw new Error("Every module type must have at least one enabled module");
  }

  if (modulesState.loaded.environment.size === 0) {
    logger.error(
      {
        environmentEnabled: enabledEnvironmentCount,
        environmentErrors: Array.from(modulesState.errors.keys()).filter(
          (key) => key.startsWith("environment."),
        ).length,
      },
      "No environment modules loaded",
    );
    throw new Error("No environment modules loaded");
  }

  if (modulesState.loaded.adapter.size === 0) {
    logger.error(
      {
        adapterEnabled: enabledAdapterCount,
        adapterErrors: Array.from(modulesState.errors.keys()).filter((key) =>
          key.startsWith("adapter."),
        ).length,
      },
      "No adapter modules loaded",
    );
    throw new Error("No adapter modules loaded");
  }

  const loadedModules = [
    ...Array.from(modulesState.loaded.environment.keys()).map((id) => ({
      id,
      type: "environment" as const,
    })),
    ...Array.from(modulesState.loaded.adapter.keys()).map((id) => ({
      id,
      type: "adapter" as const,
    })),
  ];
  logger.info({ modules: loadedModules }, "Loaded modules");

  return {
    modules: modulesState,
    pools: {
      environment: createEnvironmentPool(),
    },
  };
};
