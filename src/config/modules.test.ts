import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadModule, loadModulesConfig } from "@/config/modules";

const modulesToml = `
[environment]
localjs = { enabled = true, path = "./modules/localjs.ts" }
localpy = { enabled = false, path = "./modules/localpy.ts" }

[adapter]
openapi = { enabled = true, path = "./modules/openapi.ts" }
grpc = { enabled = false, path = "./modules/grpc.ts" }
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
      environment: {
        localjs: {
          id: "localjs",
          type: "environment",
          enabled: true,
          path: "./modules/localjs.ts",
        },
        localpy: {
          id: "localpy",
          type: "environment",
          enabled: false,
          path: "./modules/localpy.ts",
        },
      },
      adapter: {
        openapi: {
          id: "openapi",
          type: "adapter",
          enabled: true,
          path: "./modules/openapi.ts",
        },
        grpc: {
          id: "grpc",
          type: "adapter",
          enabled: false,
          path: "./modules/grpc.ts",
        },
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
      environment: {
        localjs: {
          id: "localjs",
          type: "environment",
          enabled: true,
          path: "./modules/localjs.ts",
        },
        localpy: {
          id: "localpy",
          type: "environment",
          enabled: false,
          path: "./modules/localpy.ts",
        },
      },
      adapter: {
        openapi: {
          id: "openapi",
          type: "adapter",
          enabled: true,
          path: "./modules/openapi.ts",
        },
        grpc: {
          id: "grpc",
          type: "adapter",
          enabled: false,
          path: "./modules/grpc.ts",
        },
      },
    });
  });

  it("throws when modules.toml is missing", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mci-missing-"));
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;

    expect(() => loadModulesConfig()).toThrow();
  });

  it("throws when a module section is missing a path", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mci-nopath-"));
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    writeModulesTomlContents(
      configDir,
      `
      [environment]
      localjs = { enabled = true }

      [adapter]
      openapi = { path = "./modules/openapi.ts" }
      `,
    );

    expect(() => loadModulesConfig()).toThrow(/missing "path"/);
  });

  it("throws when a module section has an empty path", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mci-emptypath-"));
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    writeModulesTomlContents(
      configDir,
      `
      [environment]
      localjs = { enabled = true, path = "" }

      [adapter]
      openapi = { path = "./modules/openapi.ts" }
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
      [environment]
      localjs = { path = "./modules/localjs.ts" }

      [adapter]
      openapi = { path = "./modules/openapi.ts" }
      `,
    );

    expect(loadModulesConfig()).toEqual({
      environment: {
        localjs: {
          id: "localjs",
          type: "environment",
          enabled: true,
          path: "./modules/localjs.ts",
        },
      },
      adapter: {
        openapi: {
          id: "openapi",
          type: "adapter",
          enabled: true,
          path: "./modules/openapi.ts",
        },
      },
    });
  });

  it("throws when a module section has an invalid enabled value", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mci-badtype-"));
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    writeModulesTomlContents(
      configDir,
      `
      [environment]
      localjs = { enabled = "yes", path = "./modules/localjs.ts" }

      [adapter]
      openapi = { path = "./modules/openapi.ts" }
      `,
    );

    expect(() => loadModulesConfig()).toThrow(/invalid "enabled"/);
  });

  it("throws when required groups are missing", () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mci-missing-group-"),
    );
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    writeModulesTomlContents(
      configDir,
      `
      [environment]
      localjs = { enabled = true, path = "./modules/localjs.ts" }
      `,
    );

    expect(() => loadModulesConfig()).toThrow(
      /section "adapter" is missing or invalid/i,
    );
  });

  it("throws when an unsupported top-level section exists", () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mci-unsupported-"),
    );
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    writeModulesTomlContents(
      configDir,
      `
      [environment]
      localjs = { enabled = true, path = "./modules/localjs.ts" }

      [adapter]
      openapi = { enabled = true, path = "./modules/openapi.ts" }

      [modules]
      legacy = { enabled = true, path = "./modules/legacy.ts" }
      `,
    );

    expect(() => loadModulesConfig()).toThrow(/unsupported top-level section/i);
  });

  it("throws when a group has no enabled modules", () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mci-no-enabled-group-"),
    );
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    writeModulesTomlContents(
      configDir,
      `
      [environment]
      localjs = { enabled = false, path = "./modules/localjs.ts" }

      [adapter]
      openapi = { enabled = true, path = "./modules/openapi.ts" }
      `,
    );

    expect(() => loadModulesConfig()).toThrow(
      /at least one module in section "environment"/i,
    );
  });

  it("throws when modules.toml is malformed", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mci-bad-"));
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    writeModulesTomlContents(
      configDir,
      `
      [environment
      localjs = { enabled = true, path = "./modules/localjs.ts" }
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

const environmentModuleSource = (
  label = "test",
  {
    includeSetup = true,
    includeTeardown = true,
    includeExecute = true,
    includeKill = true,
  } = {},
) =>
  `
import { EventEmitter } from "node:events";

class TestModule extends EventEmitter {
  type = "environment";
  label = ${JSON.stringify(label)};
  ${includeSetup ? "async setup() {}\n" : ""}
  ${includeTeardown ? "async teardown() {}\n" : ""}
  ${includeExecute ? 'async execute() {\n    return "success";\n  }\n' : ""}
  ${includeKill ? "async kill() {}\n" : ""}
}

export default new TestModule();
`.trim();

const adapterModuleSource = () =>
  `
export default { type: "adapter" };
`.trim();

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
    tempDirs.length = 0;
  });

  it("loads a default-exported environment module", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mci-module-"));
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    const modulePath = writeModuleFile(
      path.join(configDir, "modules"),
      "environment.mjs",
      environmentModuleSource(),
    );

    const result = await loadModule(modulePath, "environment");

    expect(result.error).toBeNull();
    expect(result.module).not.toBeNull();
    expect(result.module).toHaveProperty("label", "test");
  });

  it("loads a default-exported adapter module", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mci-adapter-"));
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    const modulePath = writeModuleFile(
      path.join(configDir, "modules"),
      "adapter.mjs",
      adapterModuleSource(),
    );

    const result = await loadModule(modulePath, "adapter");

    expect(result.error).toBeNull();
    expect(result.module).not.toBeNull();
  });

  it("resolves relative paths from the config directory", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mci-module-cfg-"));
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    const modulePath = writeModuleFile(
      path.join(configDir, "modules"),
      "env.mjs",
      environmentModuleSource("relative"),
    );
    const relativePath = path.relative(configDir, modulePath);

    const result = await loadModule(relativePath, "environment");

    expect(result.error).toBeNull();
    expect(result.module).not.toBeNull();
    expect(result.module).toHaveProperty("label", "relative");
  });

  it("returns an error when the module cannot be resolved", async () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mci-module-miss-"),
    );
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    const modulePath = path.join(configDir, "modules", "missing.mjs");

    const result = await loadModule(modulePath, "environment");

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

    const result = await loadModule(modulePath, "environment");

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

    const result = await loadModule(modulePath, "environment");

    expect(result.module).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toMatch(/default export/i);
  });

  it("returns an error when declared type conflicts with config type", async () => {
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

    const result = await loadModule(modulePath, "adapter");

    expect(result.module).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toMatch(/config expects "adapter"/i);
  });

  it("returns an error when environment module is loaded as adapter", async () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mci-module-group-mismatch-"),
    );
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    const modulePath = writeModuleFile(
      path.join(configDir, "modules"),
      "env-in-adapter.mjs",
      environmentModuleSource("wrong-group"),
    );

    const result = await loadModule(modulePath, "adapter");

    expect(result.module).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toMatch(/config expects "adapter"/i);
  });

  it("returns an error when the default export has an invalid label", async () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mci-module-label-"),
    );
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    const modulePath = writeModuleFile(
      path.join(configDir, "modules"),
      "bad-label.mjs",
      environmentModuleSource("", {
        includeSetup: true,
        includeExecute: true,
      }),
    );

    const result = await loadModule(modulePath, "environment");

    expect(result.module).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toMatch(/invalid label/i);
  });

  it("returns an error when the default export is missing setup", async () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mci-module-setup-"),
    );
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    const modulePath = writeModuleFile(
      path.join(configDir, "modules"),
      "bad-setup.mjs",
      environmentModuleSource("no-setup", {
        includeSetup: false,
        includeExecute: true,
      }),
    );

    const result = await loadModule(modulePath, "environment");

    expect(result.module).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toMatch(/setup/i);
  });

  it("returns an error when the default export is missing execute", async () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mci-module-execute-"),
    );
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    const modulePath = writeModuleFile(
      path.join(configDir, "modules"),
      "bad-execute.mjs",
      environmentModuleSource("no-execute", {
        includeSetup: true,
        includeExecute: false,
      }),
    );

    const result = await loadModule(modulePath, "environment");

    expect(result.module).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toMatch(/execute/i);
  });

  it("returns an error when the default export is missing teardown", async () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mci-module-teardown-"),
    );
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    const modulePath = writeModuleFile(
      path.join(configDir, "modules"),
      "bad-teardown.mjs",
      environmentModuleSource("no-teardown", {
        includeSetup: true,
        includeTeardown: false,
        includeExecute: true,
      }),
    );

    const result = await loadModule(modulePath, "environment");

    expect(result.module).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toMatch(/teardown/i);
  });

  it("returns an error when the default export is missing kill", async () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mci-module-kill-"),
    );
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    const modulePath = writeModuleFile(
      path.join(configDir, "modules"),
      "bad-kill.mjs",
      environmentModuleSource("no-kill", {
        includeSetup: true,
        includeExecute: true,
        includeKill: false,
      }),
    );

    const result = await loadModule(modulePath, "environment");

    expect(result.module).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toMatch(/kill/i);
  });

  it("returns an error when the default export does not extend EventEmitter", async () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mci-module-emitter-"),
    );
    tempDirs.push(configDir);
    process.env.MCI_CONFIG_DIR = configDir;
    const modulePath = writeModuleFile(
      path.join(configDir, "modules"),
      "bad-emitter.mjs",
      `
export default {
  type: "environment",
  label: "plain",
  async setup() {},
  async teardown() {},
  async execute() {
    return "success";
  },
  async kill() {},
};
`.trim(),
    );

    const result = await loadModule(modulePath, "environment");

    expect(result.module).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toMatch(/EventEmitter/i);
  });

  it("returns an error when the module resolves outside the config directory", async () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mci-module-outside-"),
    );
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mci-module-outside-path-"),
    );
    tempDirs.push(configDir, outsideDir);
    process.env.MCI_CONFIG_DIR = configDir;
    const modulePath = writeModuleFile(
      outsideDir,
      "outside.mjs",
      environmentModuleSource(),
    );
    const result = await loadModule(modulePath, "environment");

    expect(result.module).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toMatch(/outside config directory/i);
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
      environmentModuleSource(),
    );

    const firstResult = await loadModule(modulePath, "environment");

    expect(firstResult.error).toBeNull();

    fs.writeFileSync(modulePath, 'export default { type: "other" };', "utf8");
    fs.utimesSync(modulePath, new Date(), new Date(Date.now() + 1000));

    const secondResult = await loadModule(modulePath, "environment");

    expect(secondResult.module).toBeNull();
    expect(secondResult.error).toBeInstanceOf(Error);
    expect(secondResult.error?.message).toMatch(
      /config expects "environment"/i,
    );
  });
});
