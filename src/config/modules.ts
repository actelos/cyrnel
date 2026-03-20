import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";

import { parse } from "toml";

export type ModuleConfig = {
  id: string;
  enabled: boolean;
  path: string;
};

export type ModulesConfig = Record<string, ModuleConfig>;

export type BaseModule = {
  type: "environment";
};

export type ExecutionStatus = "success" | "failed" | "timeout" | "canceled";

export interface EnvironmentModuleEvents {
  stdout: (chunk: Buffer) => void;
  stderr: (chunk: Buffer) => void;
  output: (data: unknown) => void;
}

export interface EnvironmentModule extends BaseModule, EventEmitter {
  type: "environment";
  label: string;
  setup(): Promise<void>;
  execute(code: string): Promise<ExecutionStatus>;
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
}

export type LoadedModule =
  | { module: EnvironmentModule; error: null }
  | { module: null; error: Error };

const getConfigDir = () => {
  const env = process.env.MCI_CONFIG_DIR?.trim();
  return env ? env : path.join(os.homedir(), "mci");
};

const parseModulesToml = (contents: string): ModulesConfig => {
  const parsed = parse(contents) as Record<string, unknown>;
  const modules = Object.create(null) as ModulesConfig;

  Object.entries(parsed).forEach(([id, value]) => {
    if (id === "__proto__" || id === "constructor" || id === "prototype") {
      throw new Error(`modules.toml has invalid section "${id}"`);
    }
    if (!value || typeof value !== "object") {
      throw new Error(`modules.toml section "${id}" is invalid`);
    }

    const section = value as Record<string, unknown>;
    const modulePath = section.path;
    const moduleEnabled = section.enabled ?? true;

    if (typeof modulePath !== "string" || modulePath.length === 0) {
      throw new Error(`modules.toml section "${id}" missing "path"`);
    }

    if (typeof moduleEnabled !== "boolean") {
      throw new Error(
        `modules.toml section "${id}" has invalid "enabled" value "${String(
          moduleEnabled,
        )}"`,
      );
    }

    if (!moduleEnabled) {
      return;
    }

    modules[id] = { id, enabled: moduleEnabled, path: modulePath };
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

export const loadModule = async (modulePath: string): Promise<LoadedModule> => {
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
      Array.isArray(value) ||
      (value as EnvironmentModule).type !== "environment"
    ) {
      return {
        module: null,
        error: new Error(
          `Module at "${resolvedPath}" has an invalid default export`,
        ),
      };
    }

    return { module: value as EnvironmentModule, error: null };
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
