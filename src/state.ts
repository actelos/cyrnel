import { logger } from "@/logger";
import {
  loadModule,
  loadModulesConfig,
  type Module,
  type ModulesConfig,
} from "@/config/modules";

export type ModuleState = {
  config: ModulesConfig;
  loaded: Map<string, Module>;
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
  if (entries.length === 0) {
    logger.error({}, "No modules are enabled in config");
    throw new Error("No modules are enabled in config");
  }
  await Promise.all(
    entries.map(async ([id, config]) => {
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
      { moduleErrors: moduleState.errors.size },
      "No modules loaded",
    );
    throw new Error("No modules loaded");
  }

  const loadedModules = Array.from(moduleState.loaded.entries()).map(
    ([id, module]) => ({ id, type: module.type }),
  );
  logger.info({ modules: loadedModules }, "Loaded modules");

  return { modules: moduleState };
};
