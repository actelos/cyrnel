import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";

import { parse } from "toml";
import { Schema } from "effect";

export type ModuleConfig = {
  id: string;
  type: ModuleType;
  enabled: boolean;
  path: string;
};

export type ModulesConfig = {
  environment: Record<string, ModuleConfig>;
  adapter: Record<string, ModuleConfig>;
};

export type ModuleType = "environment" | "adapter";

export type ExecutionStatus = "success" | "failed" | "timeout" | "canceled";

export interface EnvironmentModuleEvents {
  stdout: (chunk: Buffer) => void;
  stderr: (chunk: Buffer) => void;
  output: (data: unknown) => void;
}

export interface EnvironmentModule extends EventEmitter {
  label: string;
  setup(): Promise<void>;
  teardown(): Promise<void>;
  execute(code: string): Promise<ExecutionStatus>;
  kill(): Promise<void>;
  on<U extends keyof EnvironmentModuleEvents>(
    event: U,
    listener: EnvironmentModuleEvents[U],
  ): this;
  once<U extends keyof EnvironmentModuleEvents>(
    event: U,
    listener: EnvironmentModuleEvents[U],
  ): this;
  emit<U extends keyof EnvironmentModuleEvents>(
    event: U,
    ...args: Parameters<EnvironmentModuleEvents[U]>
  ): boolean;
  off<U extends keyof EnvironmentModuleEvents>(
    event: U,
    listener: EnvironmentModuleEvents[U],
  ): this;
}

export interface AdapterToolDefinition {
  id: string;
  inputSchema: Schema.Schema.Any;
  outputSchema: Schema.Schema.Any;
  execute(): Promise<(input: unknown) => Promise<unknown>>;
}

export interface AdapterService {
  id: string;
  tools: AdapterToolDefinition[];
}

export interface AdapterModule {
  parse(): Promise<AdapterService>;
}

export const executeAdapterTool = async (
  tool: AdapterToolDefinition,
  input: unknown,
): Promise<unknown> => {
  const validatedInput = Schema.decodeUnknownSync(
    tool.inputSchema as Schema.Schema<unknown, unknown, never>,
  )(input);
  const executor = await tool.execute();
  const output = await executor(validatedInput);

  return Schema.decodeUnknownSync(
    tool.outputSchema as Schema.Schema<unknown, unknown, never>,
  )(output);
};

export type LoadedModule =
  | { module: EnvironmentModule | AdapterModule; error: null }
  | { module: null; error: Error };

const getConfigDir = () => {
  const env = process.env.MCI_CONFIG_DIR?.trim();
  return env ? env : path.join(os.homedir(), "mci");
};

const MODULE_TYPES = ["environment", "adapter"] as const;

const isReservedObjectKey = (value: string): boolean =>
  value === "__proto__" || value === "constructor" || value === "prototype";

const parseModulesToml = (contents: string): ModulesConfig => {
  const parsed = parse(contents) as Record<string, unknown>;
  const modules: ModulesConfig = {
    environment: Object.create(null) as Record<string, ModuleConfig>,
    adapter: Object.create(null) as Record<string, ModuleConfig>,
  };

  if (Object.keys(parsed).length === 0) {
    throw new Error("modules.toml is empty");
  }

  for (const key of Object.keys(parsed)) {
    if (isReservedObjectKey(key)) {
      throw new Error(`modules.toml has invalid section "${key}"`);
    }
    if (!(MODULE_TYPES as readonly string[]).includes(key)) {
      throw new Error(
        `modules.toml has unsupported top-level section "${key}"; expected one of: ${MODULE_TYPES.join(", ")}`,
      );
    }
  }

  MODULE_TYPES.forEach((moduleType) => {
    const groupValue = parsed[moduleType];

    if (
      !groupValue ||
      typeof groupValue !== "object" ||
      Array.isArray(groupValue)
    ) {
      throw new Error(
        `modules.toml section "${moduleType}" is missing or invalid`,
      );
    }

    const groupEntries = groupValue as Record<string, unknown>;

    Object.entries(groupEntries).forEach(([id, value]) => {
      if (isReservedObjectKey(id)) {
        throw new Error(
          `modules.toml section "${moduleType}" has invalid module id "${id}"`,
        );
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(
          `modules.toml section "${moduleType}.${id}" is invalid`,
        );
      }

      const section = value as Record<string, unknown>;
      const modulePath = section.path;
      const moduleEnabled = section.enabled ?? true;

      if (typeof modulePath !== "string" || modulePath.length === 0) {
        throw new Error(
          `modules.toml section "${moduleType}.${id}" missing "path"`,
        );
      }

      if (typeof moduleEnabled !== "boolean") {
        throw new Error(
          `modules.toml section "${moduleType}.${id}" has invalid "enabled" value "${String(
            moduleEnabled,
          )}"`,
        );
      }

      modules[moduleType][id] = {
        id,
        type: moduleType,
        enabled: moduleEnabled,
        path: modulePath,
      };
    });

    const enabledCount = Object.values(modules[moduleType]).filter(
      (moduleConfig) => moduleConfig.enabled,
    ).length;

    if (enabledCount === 0) {
      throw new Error(
        `modules.toml must enable at least one module in section "${moduleType}"`,
      );
    }
  });

  return modules;
};

export const loadModulesConfig = (): ModulesConfig => {
  const configDir = getConfigDir();
  const modulesPath = path.join(configDir, "modules.toml");

  let contents: string;
  try {
    contents = fs.readFileSync(modulesPath, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to read modules config at "${modulesPath}": ${(err as Error).message}`,
    );
  }

  return parseModulesToml(contents);
};

const validateDeclaredModuleType = (
  value: Record<string, unknown>,
  expectedType: ModuleType,
  resolvedPath: string,
): Error | null => {
  if (!("type" in value)) {
    return null;
  }

  const loadedType = value.type;

  if (loadedType !== expectedType) {
    return new Error(
      `Module at "${resolvedPath}" declares type "${String(loadedType)}" but config expects "${expectedType}"`,
    );
  }

  return null;
};

export const loadModule = async (
  modulePath: string,
  moduleType: ModuleType,
): Promise<LoadedModule> => {
  const configDir = getConfigDir();
  const resolvedPath = path.isAbsolute(modulePath)
    ? modulePath
    : path.resolve(configDir, modulePath);
  let realConfigDir: string;
  let realResolvedPath: string;
  try {
    realConfigDir = fs.realpathSync(configDir);
    realResolvedPath = fs.realpathSync(resolvedPath);
  } catch (err) {
    return {
      module: null,
      error: new Error(
        `Failed to resolve module path "${modulePath}": ${(err as Error).message}`,
        { cause: err },
      ),
    };
  }
  const relativeToConfig = path.relative(realConfigDir, realResolvedPath);
  if (
    relativeToConfig === ".." ||
    relativeToConfig.startsWith(`..${path.sep}`)
  ) {
    return {
      module: null,
      error: new Error(
        `Module path "${modulePath}" resolves outside config directory "${realConfigDir}"`,
      ),
    };
  }

  try {
    const moduleUrl = pathToFileURL(realResolvedPath);
    try {
      const stat = fs.statSync(realResolvedPath);
      moduleUrl.searchParams.set("mtime", String(stat.mtimeMs));
    } catch {
      moduleUrl.searchParams.set("miss", String(Date.now()));
    }
    const imported = await import(moduleUrl.href);
    const value = imported?.default;
    if (
      value === null ||
      value === undefined ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      return {
        module: null,
        error: new Error(
          `Module at "${resolvedPath}" has an invalid default export`,
        ),
      };
    }

    const moduleValue = value as Record<string, unknown>;
    const moduleTypeError = validateDeclaredModuleType(
      moduleValue,
      moduleType,
      resolvedPath,
    );
    if (moduleTypeError) {
      return {
        module: null,
        error: moduleTypeError,
      };
    }

    if (moduleType === "environment") {
      const environmentModule = value as EnvironmentModule;
      if (
        typeof environmentModule.label !== "string" ||
        environmentModule.label.trim().length === 0
      ) {
        return {
          module: null,
          error: new Error(
            `Module at "${resolvedPath}" returned an invalid label`,
          ),
        };
      }
      if (typeof environmentModule.setup !== "function") {
        return {
          module: null,
          error: new Error(
            `Module at "${resolvedPath}" is missing a setup() function`,
          ),
        };
      }
      if (typeof environmentModule.teardown !== "function") {
        return {
          module: null,
          error: new Error(
            `Module at "${resolvedPath}" is missing a teardown() function`,
          ),
        };
      }
      if (typeof environmentModule.execute !== "function") {
        return {
          module: null,
          error: new Error(
            `Module at "${resolvedPath}" is missing an execute() function`,
          ),
        };
      }
      if (typeof environmentModule.kill !== "function") {
        return {
          module: null,
          error: new Error(
            `Module at "${resolvedPath}" is missing a kill() function`,
          ),
        };
      }
      if (!(environmentModule instanceof EventEmitter)) {
        return {
          module: null,
          error: new Error(
            `Module at "${resolvedPath}" must extend EventEmitter`,
          ),
        };
      }

      return { module: environmentModule, error: null };
    }

    const adapterModule = value as AdapterModule;
    if (typeof adapterModule.parse !== "function") {
      return {
        module: null,
        error: new Error(
          `Module at "${resolvedPath}" is missing a parse() function`,
        ),
      };
    }

    return { module: adapterModule, error: null };
  } catch (err) {
    return {
      module: null,
      error: new Error(
        `Failed to load module at "${resolvedPath}": ${(err as Error).message}`,
        { cause: err },
      ),
    };
  }
};
