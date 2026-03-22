import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadModule,
  loadModulesConfig,
  type AdapterModule,
  type EnvironmentModule,
  type ExecutionStatus,
} from "@/config/modules";
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

class TestEnvironmentModule extends EventEmitter implements EnvironmentModule {
  readonly type = "environment";
  label: string;

  constructor(label = "test") {
    super();
    this.label = label;
  }

  async setup(): Promise<void> {}

  async teardown(): Promise<void> {}

  async execute(_code: string): Promise<ExecutionStatus> {
    return "success";
  }

  async kill(): Promise<void> {}
}

class TestAdapterModule implements AdapterModule {
  readonly type = "adapter";
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadServerState", () => {
  const validConfig = {
    environment: {
      localjs: {
        id: "localjs",
        type: "environment" as const,
        enabled: true,
        path: "./modules/localjs.ts",
      },
    },
    adapter: {
      openapi: {
        id: "openapi",
        type: "adapter" as const,
        enabled: true,
        path: "./modules/openapi.ts",
      },
    },
  };

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

  it("throws when no environment modules load", async () => {
    mockedLoadModulesConfig.mockReturnValue(validConfig);
    mockedLoadModule
      .mockResolvedValueOnce({ module: null, error: new Error("bad env") })
      .mockResolvedValueOnce({ module: new TestAdapterModule(), error: null });

    await expect(loadServerState()).rejects.toThrow(
      "No environment modules loaded",
    );

    expect(mockedLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        moduleType: "environment",
        moduleId: "localjs",
      }),
      "Failed to load module",
    );
  });

  it("skips disabled modules in config", async () => {
    mockedLoadModulesConfig.mockReturnValue({
      environment: {
        enabled: {
          id: "enabled",
          type: "environment",
          enabled: true,
          path: "./modules/enabled.ts",
        },
        disabled: {
          id: "disabled",
          type: "environment",
          enabled: false,
          path: "./modules/disabled.ts",
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
    const enabledModule = new TestEnvironmentModule("enabled");
    mockedLoadModule
      .mockResolvedValueOnce({ module: enabledModule, error: null })
      .mockResolvedValueOnce({ module: new TestAdapterModule(), error: null });

    const state = await loadServerState();

    expect(mockedLoadModule).toHaveBeenCalledTimes(2);
    expect(mockedLoadModule).toHaveBeenNthCalledWith(
      1,
      "./modules/enabled.ts",
      "environment",
    );
    expect(mockedLoadModule).toHaveBeenNthCalledWith(
      2,
      "./modules/openapi.ts",
      "adapter",
    );
    expect(state.modules.loaded.environment.get("enabled")).toBe(enabledModule);
    expect(state.modules.loaded.environment.has("disabled")).toBe(false);
    expect(mockedLogger.info).toHaveBeenCalledWith(
      {
        moduleType: "environment",
        moduleId: "disabled",
        modulePath: "./modules/disabled.ts",
      },
      "Skipped disabled module",
    );
  });

  it("throws when no adapter modules load", async () => {
    mockedLoadModulesConfig.mockReturnValue(validConfig);
    mockedLoadModule
      .mockResolvedValueOnce({
        module: new TestEnvironmentModule("good"),
        error: null,
      })
      .mockResolvedValueOnce({ module: null, error: new Error("bad adapter") });

    await expect(loadServerState()).rejects.toThrow(
      "No adapter modules loaded",
    );
  });

  it("returns state when environment and adapter groups both load", async () => {
    mockedLoadModulesConfig.mockReturnValue(validConfig);
    const goodEnvironmentModule = new TestEnvironmentModule("good");
    const goodAdapterModule = new TestAdapterModule();
    mockedLoadModule
      .mockResolvedValueOnce({ module: goodEnvironmentModule, error: null })
      .mockResolvedValueOnce({ module: goodAdapterModule, error: null });

    const state = await loadServerState();

    expect(mockedLoadModule).toHaveBeenCalledTimes(2);
    expect(state.modules.loaded.environment.get("localjs")).toBe(
      goodEnvironmentModule,
    );
    expect(state.modules.loaded.adapter.get("openapi")).toBe(goodAdapterModule);
    expect(mockedLogger.info).toHaveBeenCalledWith(
      {
        modules: [
          { id: "localjs", type: "environment" },
          { id: "openapi", type: "adapter" },
        ],
      },
      "Loaded modules",
    );
  });
});
