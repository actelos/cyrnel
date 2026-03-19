import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadModule, loadModulesConfig } from "@/config/modules";
import { logger } from "@/logger";
import { loadServerState } from "@/state";

vi.mock("@/config/modules", () => ({
  loadModulesConfig: vi.fn(),
  loadModule: vi.fn(),
}));

vi.mock("@/logger", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

const mockedLoadModulesConfig = vi.mocked(loadModulesConfig);
const mockedLoadModule = vi.mocked(loadModule);
const mockedLogger = vi.mocked(logger);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadServerState", () => {
  it("throws when modules config cannot be loaded", async () => {
    mockedLoadModulesConfig.mockImplementation(() => {
      throw new Error("no config");
    });

    await expect(loadServerState()).rejects.toThrow(
      "Failed to load modules config",
    );
    expect(mockedLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Failed to load modules config",
    );
  });

  it("throws when no modules are loaded", async () => {
    mockedLoadModulesConfig.mockReturnValue({
      "node-sandbox": {
        id: "node-sandbox",
        enabled: true,
        path: "./modules/node-sandbox.ts",
      },
    });
    mockedLoadModule.mockResolvedValue({
      module: null,
      error: new Error("bad module"),
    });

    await expect(loadServerState()).rejects.toThrow(
      "No modules loaded (configured: 1, enabled: 1, loaded: 0, errors: 1)",
    );

    expect(mockedLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        moduleId: "node-sandbox",
        modulePath: "./modules/node-sandbox.ts",
      }),
      "Failed to load module",
    );
    expect(mockedLogger.error).toHaveBeenCalledWith(
      {
        moduleErrors: 1,
        modulesLoaded: 0,
        modulesConfigured: 1,
        modulesEnabled: 1,
      },
      "No modules loaded",
    );
  });

  it("throws when config has no enabled modules", async () => {
    mockedLoadModulesConfig.mockReturnValue({});

    await expect(loadServerState()).rejects.toThrow(
      "No modules are enabled in config",
    );
    expect(mockedLoadModule).not.toHaveBeenCalled();
    expect(mockedLogger.error).toHaveBeenCalledWith(
      {},
      "No modules are enabled in config",
    );
  });

  it("skips disabled modules in config", async () => {
    mockedLoadModulesConfig.mockReturnValue({
      enabled: {
        id: "enabled",
        enabled: true,
        path: "./modules/enabled.ts",
      },
      disabled: {
        id: "disabled",
        enabled: false,
        path: "./modules/disabled.ts",
      },
    });
    mockedLoadModule.mockResolvedValue({
      module: { type: "environment" },
      error: null,
    });

    const state = await loadServerState();

    expect(mockedLoadModule).toHaveBeenCalledTimes(1);
    expect(mockedLoadModule).toHaveBeenCalledWith("./modules/enabled.ts");
    expect(state.modules.loaded.get("enabled")).toEqual({
      type: "environment",
    });
    expect(state.modules.loaded.has("disabled")).toBe(false);
    expect(mockedLogger.info).toHaveBeenCalledWith(
      { moduleId: "disabled", modulePath: "./modules/disabled.ts" },
      "Skipped disabled module",
    );
  });

  it("returns state when at least one module loads", async () => {
    mockedLoadModulesConfig.mockReturnValue({
      good: {
        id: "good",
        enabled: true,
        path: "./modules/good.ts",
      },
      bad: {
        id: "bad",
        enabled: true,
        path: "./modules/bad.ts",
      },
    });
    mockedLoadModule
      .mockResolvedValueOnce({ module: { type: "environment" }, error: null })
      .mockResolvedValueOnce({ module: null, error: new Error("bad module") });

    const state = await loadServerState();

    expect(mockedLoadModule).toHaveBeenCalledTimes(2);
    expect(state.modules.loaded.get("good")).toEqual({ type: "environment" });
    expect(state.modules.errors.get("bad")).toBeInstanceOf(Error);
    expect(mockedLogger.info).toHaveBeenCalledWith(
      { modules: [{ id: "good", type: "environment" }] },
      "Loaded modules",
    );
  });
});
