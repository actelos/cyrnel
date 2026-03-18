import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "toml";

export type ModuleType = "environment";

export type ModuleConfig = {
  id: string;
  path: string;
  type: ModuleType;
};

export type ModulesConfig = Record<string, ModuleConfig>;

const getConfigDir = () =>
  process.env.MCI_CONFIG_DIR ?? path.join(os.homedir(), "mci");

const parseModulesToml = (contents: string): ModulesConfig => {
  const parsed = parse(contents) as Record<string, unknown>;
  const modules: ModulesConfig = {};

  Object.entries(parsed).forEach(([id, value]) => {
    if (!value || typeof value !== "object") {
      throw new Error(`modules.toml section "${id}" is invalid`);
    }

    const section = value as Record<string, unknown>;
    const modulePath = section.path;
    const moduleType = section.type;

    if (typeof modulePath !== "string" || modulePath.length === 0) {
      throw new Error(`modules.toml section "${id}" missing "path"`);
    }

    if (moduleType !== "environment") {
      throw new Error(
        `modules.toml section "${id}" has unsupported type "${String(
          moduleType,
        )}"`,
      );
    }

    modules[id] = { id, path: modulePath, type: "environment" };
  });

  return modules;
};

export const loadModulesConfig = (): ModulesConfig => {
  const configDir = getConfigDir();
  const modulesPath = path.join(configDir, "modules.toml");
  const contents = fs.readFileSync(modulesPath, "utf8");
  return parseModulesToml(contents);
};
