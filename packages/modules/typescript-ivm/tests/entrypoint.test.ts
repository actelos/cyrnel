import type {
  EnvironmentBindings,
  ExecutionInput,
  ModuleLogBindings,
  ModuleLogger,
} from "@cyrnel/sdk";
import { describe, expect, it, vi } from "vitest";

import mod from "@/index";

const stubLogger: ModuleLogger<ModuleLogBindings> = {
  context: {},
  child: <Next extends ModuleLogBindings>(
    bindings: Next,
  ): ModuleLogger<ModuleLogBindings & Next> =>
    ({
      ...stubLogger,
      context: { ...stubLogger.context, ...bindings },
    }) as ModuleLogger<ModuleLogBindings & Next>,
  redact: () => stubLogger,
  isLevelEnabled: () => true,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
};

const infiniteCode = "while (true) {}";
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("typescript-ivm integration", () => {
  const createBindings = () =>
    ({
      setState: vi.fn(),
      invokeTool: vi.fn(),
      emitStdout: vi.fn(),
      emitStderr: vi.fn(),
      emitOutput: vi.fn(),
      setError: vi.fn(),
    }) satisfies EnvironmentBindings;

  it("executes via the public entrypoint", async () => {
    const environment = mod.instantiate();
    const bindings = createBindings();

    await environment.setup({
      bindings,
      config: {},
      secrets: {},
      logger: stubLogger,
    });

    const result = await environment.execute({
      eid: 100,
      code: "const value = 1 + 1;",
      envConfig: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);

    expect(result).toBe("success");
  });

  it("kills executions via the public entrypoint", async () => {
    const environment = mod.instantiate();
    const bindings = createBindings();

    await environment.setup({
      bindings,
      config: {},
      secrets: {},
      logger: stubLogger,
    });

    const promise = environment.execute({
      eid: 101,
      code: infiniteCode,
      envConfig: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);

    await tick();
    await environment.kill(101);

    await expect(promise).resolves.toMatch(/failed|canceled/);
  });
});
