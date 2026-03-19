import { createApp } from "@/app";
import { logger } from "@/logger";
import {
  loadModule,
  loadModulesConfig,
  type Module,
  type ModulesConfig,
} from "@/config/modules";

const PORT = Number(process.env.PORT ?? 7687);

type ModuleState = {
  config: ModulesConfig;
  loaded: Map<string, Module>;
  errors: Map<string, Error>;
};

type ServerState = {
  modules: ModuleState;
};

const loadServerState = async (): Promise<ServerState> => {
  let modulesConfig: ModulesConfig;
  try {
    modulesConfig = loadModulesConfig();
  } catch (err) {
    logger.error({ err }, "Failed to load modules config; shutting down");
    process.exit(1);
  }

  const moduleState: ModuleState = {
    config: modulesConfig,
    loaded: new Map(),
    errors: new Map(),
  };

  const entries = Object.entries(modulesConfig);
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
      "No modules loaded; shutting down",
    );
    process.exit(1);
  }

  const loadedModules = Array.from(moduleState.loaded.entries()).map(
    ([id, module]) => ({ id, type: module.type }),
  );
  logger.debug({ modules: loadedModules }, "Loaded modules");

  return { modules: moduleState };
};

const startServer = async () => {
  const serverState = await loadServerState();
  const app = createApp();

  app.locals.serverState = serverState;

  app.listen(PORT, () => {
    logger.info(`Listening on port: ${PORT}`);
  });
};

startServer().catch((err) => {
  logger.error({ err }, "Failed to start server");
});
