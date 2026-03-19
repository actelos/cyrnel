import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadModulesConfig } from "@/config/modules";

const modulesToml = `
[node-sandbox]
enabled = true
path = "./modules/node-sandbox.ts"

[python-sandbox]
enabled = false
path = "./modules/python-sandbox.ts"
`;

const writeModulesToml = (configDir: string) => {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "modules.toml"), modulesToml, "utf8");
};

const writeModulesTomlContents = (configDir: string, contents: string) => {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "modules.toml"), contents, "utf8");
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
        enabled: true,
        path: "./modules/node-sandbox.ts",
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
        enabled: true,
        path: "./modules/node-sandbox.ts",
      },
    });
  });

  it("throws when modules.toml is missing", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mci-missing-"));
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;

    expect(() => loadModulesConfig()).toThrow();
  });

  it("throws when a section is missing a path", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mci-nopath-"));
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    writeModulesTomlContents(
      configDir,
      `
      [node-sandbox]
      enabled = true
      `,
    );

    expect(() => loadModulesConfig()).toThrow(/missing "path"/);
  });

  it("throws when a section has an empty path", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mci-emptypath-"));
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    writeModulesTomlContents(
      configDir,
      `
      [node-sandbox]
      enabled = true
      path = ""
      `,
    );

    expect(() => loadModulesConfig()).toThrow(/missing "path"/);
  });

  it("defaults enabled to true when missing", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mci-noenabled-"));
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    writeModulesTomlContents(
      configDir,
      `
      [node-sandbox]
      path = "./modules/node-sandbox.ts"
      `,
    );

    expect(loadModulesConfig()).toEqual({
      "node-sandbox": {
        id: "node-sandbox",
        enabled: true,
        path: "./modules/node-sandbox.ts",
      },
    });
  });

  it("throws when a section has an invalid enabled value", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mci-badtype-"));
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    writeModulesTomlContents(
      configDir,
      `
      [node-sandbox]
      enabled = "yes"
      path = "./modules/node-sandbox.ts"
      `,
    );

    expect(() => loadModulesConfig()).toThrow(/invalid "enabled"/);
  });

  it("throws when modules.toml is malformed", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mci-bad-"));
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    writeModulesTomlContents(
      configDir,
      `
      [node-sandbox
      enabled = true
      path = "./modules/node-sandbox.ts"
      `,
    );

    expect(() => loadModulesConfig()).toThrow();
  });
});
