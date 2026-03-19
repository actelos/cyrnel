import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadModule, loadModulesConfig } from "@/config/modules";

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

const writeModuleFile = (dir: string, name: string, contents: string) => {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
};

describe("loadModule", () => {
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
  });

  it("loads a default-exported module object", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mci-module-"));
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    const modulePath = writeModuleFile(
      path.join(configDir, "modules"),
      "environment.mjs",
      'export default { type: "environment" };',
    );

    const result = await loadModule(modulePath);

    expect(result.module).toEqual({ type: "environment" });
    expect(result.error).toBeNull();
  });

  it("resolves relative paths from the config directory", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mci-module-cfg-"));
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    const modulePath = writeModuleFile(
      path.join(configDir, "modules"),
      "env.mjs",
      'export default { type: "environment" };',
    );
    const relativePath = path.relative(configDir, modulePath);

    const result = await loadModule(relativePath);

    expect(result.module).toEqual({ type: "environment" });
    expect(result.error).toBeNull();
  });

  it("returns an error when the module cannot be resolved", async () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mci-module-miss-"),
    );
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    const modulePath = path.join(configDir, "modules", "missing.mjs");

    const result = await loadModule(modulePath);

    expect(result.module).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain(modulePath);
  });

  it("returns an error when the module has no default export", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mci-module-nd-"));
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    const modulePath = writeModuleFile(
      path.join(configDir, "modules"),
      "no-default.mjs",
      "export const value = 1;",
    );

    const result = await loadModule(modulePath);

    expect(result.module).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toMatch(/default export/i);
  });

  it("returns an error when the default export is not an object", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mci-module-bad-"));
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    const modulePath = writeModuleFile(
      path.join(configDir, "modules"),
      "bad-default.mjs",
      'export default "not-an-object";',
    );

    const result = await loadModule(modulePath);

    expect(result.module).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toMatch(/default export/i);
  });

  it("returns an error when the default export has an invalid type", async () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mci-module-type-"),
    );
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    const modulePath = writeModuleFile(
      path.join(configDir, "modules"),
      "bad-type.mjs",
      'export default { type: "other" };',
    );

    const result = await loadModule(modulePath);

    expect(result.module).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toMatch(/default export/i);
  });

  it("reloads a module when the file changes", async () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mci-module-reload-"),
    );
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    const modulePath = writeModuleFile(
      path.join(configDir, "modules"),
      "reload.mjs",
      'export default { type: "environment" };',
    );

    const firstResult = await loadModule(modulePath);

    expect(firstResult.module).toEqual({ type: "environment" });
    expect(firstResult.error).toBeNull();

    fs.writeFileSync(modulePath, 'export default { type: "other" };', "utf8");
    fs.utimesSync(modulePath, new Date(), new Date(Date.now() + 1000));

    const secondResult = await loadModule(modulePath);

    expect(secondResult.module).toBeNull();
    expect(secondResult.error).toBeInstanceOf(Error);
    expect(secondResult.error?.message).toMatch(/default export/i);
  });
});
