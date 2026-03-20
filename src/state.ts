import { logger } from "@/logger";
import {
  loadModule,
  loadModulesConfig,
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
    },
    errors: new Map(),
  };

  const entries = Object.entries(modulesConfig);
  const totalConfigured = entries.length;
  const totalEnabled = entries.filter(([, config]) => config.enabled).length;

  if (totalEnabled === 0) {
    logger.error({}, "No modules are enabled in config");
    throw new Error("No modules are enabled in config");
  }
  await Promise.all(
    entries.map(async ([id, config]) => {
      if (!config.enabled) {
        logger.info(
          { moduleId: id, modulePath: config.path },
          "Skipped disabled module",
        );
        return;
      }
      const result = await loadModule(config.path);
      if (result.error) {
        modulesState.errors.set(id, result.error);
        logger.error(
          { err: result.error, moduleId: id, modulePath: config.path },
          "Failed to load module",
        );
        return;
      }
      switch (result.module.type) {
        case "environment":
          modulesState.loaded.environment.set(id, result.module);
          break;
        default:
          modulesState.errors.set(
            id,
            new Error(`Unknown module type: ${result.module.type}`),
          );
          logger.error(
            { moduleId: id, moduleType: result.module.type },
            "Unknown module type loaded",
          );
          return;
      }
    }),
  );

  const totalLoadedCount = Object.values(modulesState.loaded).reduce(
    (total, modules) => total + modules.size,
    0,
  );
  if (totalLoadedCount === 0) {
    logger.error(
      {
        moduleErrors: modulesState.errors.size,
        modulesLoaded: totalLoadedCount,
        modulesConfigured: totalConfigured,
        modulesEnabled: totalEnabled,
      },
      "No modules loaded",
    );
    throw new Error(
      `No modules loaded (configured: ${totalConfigured}, enabled: ${totalEnabled}, loaded: ${totalLoadedCount}, errors: ${modulesState.errors.size})`,
    );
  }

  const loadedModules = Object.entries(modulesState.loaded).flatMap(
    ([, modules]) =>
      Array.from(modules.entries()).map(([id, module]) => ({
        id,
        type: module.type,
      })),
  );
  logger.info({ modules: loadedModules }, "Loaded modules");

  return {
    modules: modulesState,
    pools: {
      environment: createEnvironmentPool(),
    },
  };
};
