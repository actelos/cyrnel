import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadModulesConfig } from "@/config/modules";

const modulesToml = `[node-sandbox]
path = "./modules/node-sandbox.ts"
type = "environment"

[python-sandbox]
path = "./modules/python-sandbox.ts"
type = "environment"
`;

const writeModulesToml = (configDir: string) => {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "modules.toml"), modulesToml, "utf8");
};

describe("loadModulesConfig", () => {
  const originalConfigDir = process.env.MCI_CONFIG_DIR;
  let tempDirs: string[] = [];

  beforeEach(() => {
    delete process.env.MCI_CONFIG_DIR;
    tempDirs = [];
  });

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.MCI_CONFIG_DIR;
    } else {
      process.env.MCI_CONFIG_DIR = originalConfigDir;
    }
    tempDirs.forEach((dir) => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    vi.restoreAllMocks();
  });

  it("loads modules.toml from MCI_CONFIG_DIR", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mci-config-"));
    tempDirs.push(configDir);
    writeModulesToml(configDir);
    process.env.MCI_CONFIG_DIR = configDir;

    expect(loadModulesConfig()).toEqual({
      "node-sandbox": {
        id: "node-sandbox",
        path: "./modules/node-sandbox.ts",
        type: "environment",
      },
      "python-sandbox": {
        id: "python-sandbox",
        path: "./modules/python-sandbox.ts",
        type: "environment",
      },
    });
  });

  it("defaults to ~/mci/modules.toml when MCI_CONFIG_DIR is unset", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mci-home-"));
    const homeDir = path.join(root, "home");
    const configDir = path.join(homeDir, "mci");
    tempDirs.push(root);
    writeModulesToml(configDir);

    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    expect(loadModulesConfig()).toEqual({
      "node-sandbox": {
        id: "node-sandbox",
        path: "./modules/node-sandbox.ts",
        type: "environment",
      },
      "python-sandbox": {
        id: "python-sandbox",
        path: "./modules/python-sandbox.ts",
        type: "environment",
      },
    });
  });

  it("throws when modules.toml is missing", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mci-missing-"));
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;

    expect(() => loadModulesConfig()).toThrow();
  });
});
