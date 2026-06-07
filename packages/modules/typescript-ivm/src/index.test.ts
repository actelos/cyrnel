import type { EnvironmentBindings, ExecutionInput } from "@cyrnel/sdk";
import { describe, expect, it, vi } from "vitest";

import { instantiate, manifest, toBuffer } from "./index";

describe("typescript-ivm manifest", () => {
  it("uses id as the stable identifier and name as the display label", () => {
    expect(manifest).toMatchObject({
      id: "typescript-ivm",
      name: "Typescript Isolated VM",
      type: "environment",
    });
  });

  it("declares the supported configSchema", () => {
    expect(manifest.configSchema).toMatchObject({
      type: "object",
      properties: { poolSize: { type: "integer", minimum: 1 } },
      additionalProperties: false,
    });
  });

  it("declares an empty object secretsSchema", () => {
    expect(manifest.secretsSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
  });
});

describe("toBuffer", () => {
  it("returns buffer inputs unchanged", () => {
    const input = Buffer.from("hello", "utf8");

    const result = toBuffer(input);

    expect(result).toBe(input);
  });

  it("converts string inputs to buffers", () => {
    const result = toBuffer("hello");

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.toString("utf8")).toBe("hello");
  });

  it("converts Uint8Array inputs to buffers", () => {
    const input = Uint8Array.from([1, 2, 3]);

    const result = toBuffer(input);

    expect(Buffer.isBuffer(result)).toBe(true);
    expect([...result]).toEqual([1, 2, 3]);
  });

  it("stringifies non-text inputs", () => {
    const result = toBuffer(42);

    expect(result.toString("utf8")).toBe("42");
  });

  it("throws when buffer exceeds the size limit", () => {
    const maxSize = 4 * 1024 * 1024;

    expect(() => toBuffer(Buffer.alloc(maxSize + 1))).toThrow(
      new RangeError(
        `Text exceeds maximum size (${maxSize + 1} > ${maxSize} bytes)`,
      ),
    );
  });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const busyCode = `let counter = 0;
while (counter < 200_000) {
  counter += 1;
}`;

const longBusyCode = `let counter = 0;
while (counter < 20_000_000) {
  counter += 1;
}`;

const infiniteCode = `while (true) {}`;

describe("environment module", () => {
  const createBindings = () => {
    const setState = vi.fn<EnvironmentBindings["setState"]>();

    return {
      bindings: {
        setState,
        discoverServices: vi.fn(),
        discoverTools: vi.fn(),
        getService: vi.fn(),
        getTool: vi.fn(),
        getToolDocs: vi.fn(),
        invokeTool: vi.fn(),
        emitStdout: vi.fn(),
        emitStderr: vi.fn(),
        emitOutput: vi.fn(),
        setError: vi.fn(),
      } satisfies EnvironmentBindings,
      setState,
    };
  };

  it("queues then runs executions", async () => {
    const { bindings, setState } = createBindings();
    const environment = instantiate();

    await environment.setup({ bindings, config: {}, secrets: {} });

    const promise = environment.execute({
      eid: 42,
      code: "const answer = 40 + 2;",
      options: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);

    const result = await promise;

    expect(result).toBe("success");
    expect(setState).toHaveBeenNthCalledWith(1, 42, "queued");
    expect(setState).toHaveBeenNthCalledWith(2, 42, "running");
  });

  it("limits concurrent executions to two", async () => {
    const { bindings, setState } = createBindings();
    const environment = instantiate();

    await environment.setup({ bindings, config: {}, secrets: {} });

    const exec1 = environment.execute({
      eid: 1,
      code: infiniteCode,
      options: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);
    const exec2 = environment.execute({
      eid: 2,
      code: infiniteCode,
      options: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);
    const exec3 = environment.execute({
      eid: 3,
      code: "const done = true;",
      options: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);

    await tick();

    expect(
      setState.mock.calls.some(
        ([eid, state]) => eid === 3 && state === "running",
      ),
    ).toBe(false);

    await Promise.all([environment.kill(1), environment.kill(2)]);

    const [result1, result2, result3] = await Promise.all([
      exec1,
      exec2,
      exec3,
    ]);

    expect(result1).toBe("canceled");
    expect(result2).toBe("canceled");
    expect(result3).toBe("success");
    expect(setState).toHaveBeenCalledWith(3, "running");
  });

  it("continues after teardown", async () => {
    const { bindings } = createBindings();
    const environment = instantiate();

    await environment.setup({ bindings, config: {}, secrets: {} });

    await environment.execute({
      eid: 4,
      code: busyCode,
      options: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);

    await environment.teardown();

    await environment.setup({ bindings, config: {}, secrets: {} });

    const result = await environment.execute({
      eid: 5,
      code: "const ok = true;",
      options: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);

    expect(result).toBe("success");
  });

  it("returns failed for runtime errors", async () => {
    const { bindings } = createBindings();
    const environment = instantiate();

    await environment.setup({ bindings, config: {}, secrets: {} });

    const result = await environment.execute({
      eid: 7,
      code: "throw new Error('boom');",
      options: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);

    expect(result).toBe("failed");
  });

  it("returns failed for transpile errors", async () => {
    const { bindings } = createBindings();
    const environment = instantiate();

    await environment.setup({ bindings, config: {}, secrets: {} });

    const result = await environment.execute({
      eid: 8,
      code: "const =",
      options: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);

    expect(result).toBe("failed");
  });

  it("cancels queued executions on kill", async () => {
    const { bindings } = createBindings();
    const environment = instantiate();

    await environment.setup({ bindings, config: {}, secrets: {} });

    const exec1 = environment.execute({
      eid: 1,
      code: longBusyCode,
      options: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);
    const exec2 = environment.execute({
      eid: 2,
      code: longBusyCode,
      options: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);
    const exec3 = environment.execute({
      eid: 3,
      code: "const queued = true;",
      options: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);

    await tick();

    await environment.kill(3);

    expect(await exec3).toBe("canceled");
    await Promise.all([exec1, exec2]);
  });

  it("cancels running executions on kill", async () => {
    const { bindings } = createBindings();
    const environment = instantiate();

    await environment.setup({ bindings, config: {}, secrets: {} });

    const promise = environment.execute({
      eid: 9,
      code: infiniteCode,
      options: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);

    await tick();
    await environment.kill(9);

    const result = await promise;

    expect(result).toBe("canceled");
  });

  it("continues executing after a kill", async () => {
    const { bindings } = createBindings();
    const environment = instantiate();

    await environment.setup({ bindings, config: {}, secrets: {} });

    const promise = environment.execute({
      eid: 10,
      code: infiniteCode,
      options: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);

    await tick();
    await environment.kill(10);
    await promise;

    const followup = await environment.execute({
      eid: 11,
      code: "const ok = true;",
      options: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);

    expect(followup).toBe("success");
  }, 10_000);

  it("times out when timeoutMs is provided", async () => {
    const { bindings } = createBindings();
    const environment = instantiate();

    await environment.setup({ bindings, config: {}, secrets: {} });

    const result = await environment.execute({
      eid: 12,
      code: infiniteCode,
      options: { timeoutMs: 5 },
    } satisfies ExecutionInput);

    expect(result).toBe("timeout");
  });

  it("returns failed when execution throws an error", async () => {
    const { bindings } = createBindings();
    const environment = instantiate();

    await environment.setup({ bindings, config: {}, secrets: {} });

    const result = await environment.execute({
      eid: 13,
      code: "throw new Error('intentional failure');",
      options: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);

    expect(result).toBe("failed");
  });

  it("rejects duplicate execution IDs", async () => {
    const { bindings } = createBindings();
    const environment = instantiate();

    await environment.setup({ bindings, config: {}, secrets: {} });

    const promise = environment.execute({
      eid: 20,
      code: infiniteCode,
      options: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);

    await tick();

    await expect(
      environment.execute({
        eid: 20,
        code: "const second = true;",
        options: { timeoutMs: 30_000 },
      } satisfies ExecutionInput),
    ).rejects.toThrow(/already running/i);

    await environment.kill(20);
    await promise;
  });

  it("throws when executing without setup", async () => {
    const environment = instantiate();

    await expect(
      environment.execute({
        eid: 30,
        code: "const x = 1;",
        options: { timeoutMs: 30_000 },
      } satisfies ExecutionInput),
    ).rejects.toThrow(/not setup/i);
  });

  it("cancels queued work during teardown", async () => {
    const { bindings } = createBindings();
    const environment = instantiate();

    await environment.setup({ bindings, config: {}, secrets: {} });

    const exec1 = environment.execute({
      eid: 31,
      code: longBusyCode,
      options: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);
    const exec2 = environment.execute({
      eid: 32,
      code: longBusyCode,
      options: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);
    const exec3 = environment.execute({
      eid: 33,
      code: "const queued = true;",
      options: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);

    await tick();

    await environment.teardown();

    expect(await exec3).toBe("canceled");
    await Promise.all([exec1, exec2]);
  });
});
