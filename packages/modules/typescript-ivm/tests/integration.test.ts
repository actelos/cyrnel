import type { EnvironmentBindings, ExecutionParams } from "@mci/sdk";
import { instantiate } from "@mci/typescript-ivm";
import { describe, expect, it, vi } from "vitest";

const infiniteCode = "while (true) {}";
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("typescript-ivm integration", () => {
  const createBindings = () =>
    ({
      setState: vi.fn(),
      discoverServices: vi.fn(),
      discoverTools: vi.fn(),
      getService: vi.fn(),
      getTool: vi.fn(),
      invokeTool: vi.fn(),
      emitStdout: vi.fn(),
      emitStderr: vi.fn(),
      emitOutput: vi.fn(),
    }) satisfies EnvironmentBindings;

  it("executes via the public entrypoint", async () => {
    const environment = instantiate();
    const bindings = createBindings();

    await environment.setup({ bindings });

    const result = await environment.execute({
      eid: 100,
      code: "const value = 1 + 1;",
      options: {},
    } satisfies ExecutionParams);

    expect(result).toBe("success");
  });

  it("kills executions via the public entrypoint", async () => {
    const environment = instantiate();
    const bindings = createBindings();

    await environment.setup({ bindings });

    const promise = environment.execute({
      eid: 101,
      code: infiniteCode,
      options: {},
    } satisfies ExecutionParams);

    await tick();
    await environment.kill(101);

    await expect(promise).resolves.toMatch(/failed|canceled/);
  });
});
