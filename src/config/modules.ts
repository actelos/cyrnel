import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "toml";

export type ModuleConfig = {
  id: string;
  enabled: boolean;
  path: string;
};

export type ModulesConfig = Record<string, ModuleConfig>;

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
