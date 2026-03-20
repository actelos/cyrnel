import { logger } from "@/logger";
import {
  loadModule,
  loadModulesConfig,
  type EnvironmentModule,
  type ModulesConfig,
} from "@/config/modules";

export type ModuleState = {
  config: ModulesConfig;
  loaded: Map<string, EnvironmentModule>;
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
    loaded: new Map(),
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
      moduleState.loaded.set(id, result.module);
    }),
  );

  if (moduleState.loaded.size === 0) {
    logger.error(
      {
        moduleErrors: moduleState.errors.size,
        modulesLoaded: moduleState.loaded.size,
        modulesConfigured: totalConfigured,
        modulesEnabled: totalEnabled,
      },
      "No modules loaded",
    );
    throw new Error(
      `No modules loaded (configured: ${totalConfigured}, enabled: ${totalEnabled}, loaded: ${moduleState.loaded.size}, errors: ${moduleState.errors.size})`,
    );
  }

  const loadedModules = Array.from(moduleState.loaded.entries()).map(
    ([id, module]) => ({ id, type: module.type }),
  );
  logger.info({ modules: loadedModules }, "Loaded modules");

  return { modules: moduleState };
};
