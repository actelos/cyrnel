import { logger } from "@/logger";
import {
  loadModule,
  loadModulesConfig,
  type AdapterModule,
  type AdapterService,
  type AdapterToolDefinition,
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
  catalog: {
    services: Map<
      string,
      {
        adapterId: string;
        service: AdapterService;
      }
    >;
    tools: Map<
      string,
      {
        adapterId: string;
        serviceId: string;
        toolId: string;
        toolPath: string;
        tool: AdapterToolDefinition;
      }
    >;
  };
  errors: Map<string, Error>;
};

export type ServerState = {
  modules: ModulesState;
  pools: {
    environment: EnvironmentPool;
  };
};

export const createAdapterToolPath = (
  adapterId: string,
  serviceId: string,
  toolId: string,
): string => `${adapterId}.${serviceId}.${toolId}`;

const clearCatalogErrors = (modulesState: ModulesState): void => {
  for (const key of Array.from(modulesState.errors.keys())) {
    if (
      key.startsWith("adapter.") &&
      (key.endsWith(".parse") || key.includes(".catalog."))
    ) {
      modulesState.errors.delete(key);
    }
  }
};

const normalizeId = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

export const refreshAdapterCatalog = async (
  modulesState: ModulesState,
): Promise<void> => {
  clearCatalogErrors(modulesState);
  modulesState.catalog.services.clear();
  modulesState.catalog.tools.clear();

  for (const [
    adapterId,
    adapterModule,
  ] of modulesState.loaded.adapter.entries()) {
    let service: AdapterService;

    try {
      service = await adapterModule.parse();
    } catch (err) {
      const error =
        err instanceof Error
          ? err
          : new Error(`Adapter parse failed: ${String(err)}`);
      modulesState.errors.set(`adapter.${adapterId}.parse`, error);
      logger.error(
        { err: error, adapterId },
        "Failed to parse adapter service",
      );
      continue;
    }

    const serviceId = normalizeId(service?.id);
    if (!serviceId) {
      const error = new Error("Adapter parse returned service with invalid id");
      modulesState.errors.set(`adapter.${adapterId}.catalog.service`, error);
      logger.error({ err: error, adapterId }, "Invalid adapter service id");
      continue;
    }

    const existingService = modulesState.catalog.services.get(serviceId);
    if (existingService) {
      const error = new Error(
        `Duplicate service id "${serviceId}" from adapter "${adapterId}"; already provided by "${existingService.adapterId}"`,
      );
      modulesState.errors.set(`adapter.${adapterId}.catalog.service`, error);
      logger.error(
        {
          err: error,
          adapterId,
          serviceId,
          existingAdapterId: existingService.adapterId,
        },
        "Duplicate adapter service id",
      );
      continue;
    }

    if (!Array.isArray(service.tools)) {
      const error = new Error(
        `Service "${serviceId}" returned invalid tools list from adapter "${adapterId}"`,
      );
      modulesState.errors.set(`adapter.${adapterId}.catalog.tools`, error);
      logger.error({ err: error, adapterId, serviceId }, "Invalid tools list");
      continue;
    }

    const seenToolIds = new Set<string>();
    let hasToolValidationError = false;
    for (const tool of service.tools) {
      const toolId = normalizeId(tool?.id);
      if (!toolId) {
        hasToolValidationError = true;
        const error = new Error(
          `Service "${serviceId}" has tool with invalid id in adapter "${adapterId}"`,
        );
        modulesState.errors.set(`adapter.${adapterId}.catalog.tools`, error);
        logger.error({ err: error, adapterId, serviceId }, "Invalid tool id");
        break;
      }

      if (seenToolIds.has(toolId)) {
        hasToolValidationError = true;
        const error = new Error(
          `Service "${serviceId}" has duplicate tool id "${toolId}" in adapter "${adapterId}"`,
        );
        modulesState.errors.set(`adapter.${adapterId}.catalog.tools`, error);
        logger.error(
          { err: error, adapterId, serviceId, toolId },
          "Duplicate tool id within service",
        );
        break;
      }

      seenToolIds.add(toolId);
    }

    if (hasToolValidationError) {
      continue;
    }

    modulesState.catalog.services.set(serviceId, { adapterId, service });

    for (const tool of service.tools) {
      const toolId = tool.id.trim();
      const toolPath = createAdapterToolPath(adapterId, serviceId, toolId);
      modulesState.catalog.tools.set(toolPath, {
        adapterId,
        serviceId,
        toolId,
        toolPath,
        tool,
      });
    }
  }

  logger.info(
    {
      catalogServices: modulesState.catalog.services.size,
      catalogTools: modulesState.catalog.tools.size,
    },
    "Built adapter catalog",
  );
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
    catalog: {
      services: new Map(),
      tools: new Map(),
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

  if (modulesState.loaded.environment.size === 0) {
    logger.error(
      {
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
        adapterErrors: Array.from(modulesState.errors.keys()).filter((key) =>
          key.startsWith("adapter."),
        ).length,
      },
      "No adapter modules loaded",
    );
    throw new Error("No adapter modules loaded");
  }

  await refreshAdapterCatalog(modulesState);

  if (modulesState.catalog.services.size === 0) {
    logger.error(
      {
        adapterLoaded: modulesState.loaded.adapter.size,
        adapterCatalogErrors: Array.from(modulesState.errors.keys()).filter(
          (key) => key.startsWith("adapter.") && key.includes(".catalog."),
        ).length,
        adapterParseErrors: Array.from(modulesState.errors.keys()).filter(
          (key) => key.endsWith(".parse"),
        ).length,
      },
      "No adapter services catalogued",
    );
    throw new Error("No adapter services catalogued");
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
