import { logger } from "@/logger";
import {
  loadModule,
  loadModulesConfig,
  type EnvironmentModule,
  type ModulesConfig,
} from "@/config/modules";

export type ModuleState = {
  config: ModulesConfig;
  loaded: {
    environment: Map<string, EnvironmentModule>;
  };
  errors: Map<string, Error>;
};

export type ServerState = {
  modules: ModuleState;
};

export const loadServerState = async (): Promise<ServerState> => {
  let modulesConfig: ModulesConfig;
  try {
    modulesConfig = loadModulesConfig();
  } catch (err) {
    logger.error({ err }, "Failed to load modules config");
    throw new Error("Failed to load modules config", { cause: err });
  }

  const moduleState: ModuleState = {
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
        moduleState.errors.set(id, result.error);
        logger.error(
          { err: result.error, moduleId: id, modulePath: config.path },
          "Failed to load module",
        );
        return;
      }
      moduleState.loaded.environment.set(id, result.module);
    }),
  );

  const environmentLoadedCount = moduleState.loaded.environment.size;
  if (environmentLoadedCount === 0) {
    logger.error(
      {
        moduleErrors: moduleState.errors.size,
        modulesLoaded: environmentLoadedCount,
        modulesConfigured: totalConfigured,
        modulesEnabled: totalEnabled,
      },
      "No modules loaded",
    );
    throw new Error(
      `No modules loaded (configured: ${totalConfigured}, enabled: ${totalEnabled}, loaded: ${environmentLoadedCount}, errors: ${moduleState.errors.size})`,
    );
  }

  const loadedModules = Array.from(
    moduleState.loaded.environment.entries(),
  ).map(([id, module]) => ({ id, type: module.type }));
  logger.info({ modules: loadedModules }, "Loaded modules");

  return { modules: moduleState };
};
