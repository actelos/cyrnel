import type {
  EnvironmentBindings,
  ExecutionInput,
  ModuleLogBindings,
  ModuleLogger,
} from "@cyrnel/sdk";
import { describe, expect, it, vi } from "vitest";

import tsivm, { toBuffer } from "@/index";

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

describe("typescript-ivm default export", () => {
  it("declares the supported configSchema", () => {
    expect(tsivm.configSchema).toMatchObject({
      type: "object",
      properties: {
        poolSize: { type: "integer", minimum: 1 },
        maxQueueSize: { type: "integer", minimum: 1 },
        queueTtlMs: { type: "integer", minimum: 1 },
        maxCodeSizeBytes: { type: "integer", minimum: 1024 },
        memoryLimitMb: { type: "integer", minimum: 16 },
        bindings: {
          type: "object",
          properties: {
            base64: { type: "boolean" },
            textCodecs: { type: "boolean" },
            url: { type: "boolean" },
            timers: { type: "boolean" },
            randomValues: { type: "boolean" },
            fullConsole: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    });
  });

  it("declares a null secretsSchema", () => {
    expect(tsivm.secretsSchema).toMatchObject({
      type: "null",
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

const sleep = (durationMs: number) =>
  new Promise((resolve) => setTimeout(resolve, durationMs));
const tick = () => sleep(0);

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
    const environment = tsivm.instantiate();

    await environment.setup({
      bindings,
      config: {},
      secrets: {},
      logger: stubLogger,
    });

    const promise = environment.execute({
      eid: 42,
      code: "const answer = 40 + 2;",
      envConfig: {
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
    const environment = tsivm.instantiate();

    await environment.setup({
      bindings,
      config: {},
      secrets: {},
      logger: stubLogger,
    });

    const exec1 = environment.execute({
      eid: 1,
      code: infiniteCode,
      envConfig: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);
    const exec2 = environment.execute({
      eid: 2,
      code: infiniteCode,
      envConfig: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);
    const exec3 = environment.execute({
      eid: 3,
      code: "const done = true;",
      envConfig: {
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
    const environment = tsivm.instantiate();

    await environment.setup({
      bindings,
      config: {},
      secrets: {},
      logger: stubLogger,
    });

    await environment.execute({
      eid: 4,
      code: busyCode,
      envConfig: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);

    await environment.teardown();

    await environment.setup({
      bindings,
      config: {},
      secrets: {},
      logger: stubLogger,
    });

    const result = await environment.execute({
      eid: 5,
      code: "const ok = true;",
      envConfig: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);

    expect(result).toBe("success");
  });

  it("returns failed for runtime errors", async () => {
    const { bindings } = createBindings();
    const environment = tsivm.instantiate();

    await environment.setup({
      bindings,
      config: {},
      secrets: {},
      logger: stubLogger,
    });

    const result = await environment.execute({
      eid: 7,
      code: "throw new Error('boom');",
      envConfig: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);

    expect(result).toBe("failed");
  });

  it("returns failed for transpile errors", async () => {
    const { bindings } = createBindings();
    const environment = tsivm.instantiate();

    await environment.setup({
      bindings,
      config: {},
      secrets: {},
      logger: stubLogger,
    });

    const result = await environment.execute({
      eid: 8,
      code: "const =",
      envConfig: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);

    expect(result).toBe("failed");
  });

  it("returns failed when code exceeds maxCodeSizeBytes", async () => {
    const { bindings } = createBindings();
    const environment = tsivm.instantiate();

    await environment.setup({
      bindings,
      config: { maxCodeSizeBytes: 1024 },
      secrets: {},
      logger: stubLogger,
    });

    const result = await environment.execute({
      eid: 18,
      code: "é".repeat(600),
      envConfig: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);

    expect(result).toBe("failed");
    expect(bindings.setError).toHaveBeenCalledWith(
      18,
      expect.stringContaining("Code exceeds maximum size"),
    );
  });

  it("cancels queued executions on kill", async () => {
    const { bindings } = createBindings();
    const environment = tsivm.instantiate();

    await environment.setup({
      bindings,
      config: {},
      secrets: {},
      logger: stubLogger,
    });

    const exec1 = environment.execute({
      eid: 1,
      code: longBusyCode,
      envConfig: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);
    const exec2 = environment.execute({
      eid: 2,
      code: longBusyCode,
      envConfig: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);
    const exec3 = environment.execute({
      eid: 3,
      code: "const queued = true;",
      envConfig: {
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
    const environment = tsivm.instantiate();

    await environment.setup({
      bindings,
      config: {},
      secrets: {},
      logger: stubLogger,
    });

    const promise = environment.execute({
      eid: 9,
      code: infiniteCode,
      envConfig: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);

    await tick();
    await environment.kill(9);

    const result = await promise;

    expect(result).toBe("canceled");
  });

  it("continues executing after a kill", async () => {
    const { bindings } = createBindings();
    const environment = tsivm.instantiate();

    await environment.setup({
      bindings,
      config: {},
      secrets: {},
      logger: stubLogger,
    });

    const promise = environment.execute({
      eid: 10,
      code: infiniteCode,
      envConfig: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);

    await tick();
    await environment.kill(10);
    await promise;

    const followup = await environment.execute({
      eid: 11,
      code: "const ok = true;",
      envConfig: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);

    expect(followup).toBe("success");
  }, 10_000);

  it("times out when timeoutMs is provided", async () => {
    const { bindings } = createBindings();
    const environment = tsivm.instantiate();

    await environment.setup({
      bindings,
      config: {},
      secrets: {},
      logger: stubLogger,
    });

    const result = await environment.execute({
      eid: 12,
      code: infiniteCode,
      envConfig: { timeoutMs: 5 },
    } satisfies ExecutionInput);

    expect(result).toBe("timeout");
  });

  it("returns failed when execution throws an error", async () => {
    const { bindings } = createBindings();
    const environment = tsivm.instantiate();

    await environment.setup({
      bindings,
      config: {},
      secrets: {},
      logger: stubLogger,
    });

    const result = await environment.execute({
      eid: 13,
      code: "throw new Error('intentional failure');",
      envConfig: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);

    expect(result).toBe("failed");
  });

  it("rejects duplicate execution IDs", async () => {
    const { bindings } = createBindings();
    const environment = tsivm.instantiate();

    await environment.setup({
      bindings,
      config: {},
      secrets: {},
      logger: stubLogger,
    });

    const promise = environment.execute({
      eid: 20,
      code: infiniteCode,
      envConfig: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);

    await tick();

    await expect(
      environment.execute({
        eid: 20,
        code: "const second = true;",
        envConfig: { timeoutMs: 30_000 },
      } satisfies ExecutionInput),
    ).rejects.toThrow(/already running/i);

    await environment.kill(20);
    await promise;
  });

  it("throws when executing without setup", async () => {
    const environment = tsivm.instantiate();

    await expect(
      environment.execute({
        eid: 30,
        code: "const x = 1;",
        envConfig: { timeoutMs: 30_000 },
      } satisfies ExecutionInput),
    ).rejects.toThrow(/not setup/i);
  });

  it("cancels queued work during teardown", async () => {
    const { bindings } = createBindings();
    const environment = tsivm.instantiate();

    await environment.setup({
      bindings,
      config: {},
      secrets: {},
      logger: stubLogger,
    });

    const exec1 = environment.execute({
      eid: 31,
      code: longBusyCode,
      envConfig: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);
    const exec2 = environment.execute({
      eid: 32,
      code: longBusyCode,
      envConfig: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);
    const exec3 = environment.execute({
      eid: 33,
      code: "const queued = true;",
      envConfig: {
        timeoutMs: 30_000,
      },
    } satisfies ExecutionInput);

    await tick();

    await environment.teardown();

    expect(await exec3).toBe("canceled");
    await Promise.all([exec1, exec2]);
  });

  it("cancels queued work that exceeds queueTtlMs", async () => {
    const { bindings, setState } = createBindings();
    const environment = tsivm.instantiate();

    await environment.setup({
      bindings,
      config: { poolSize: 1, queueTtlMs: 1 },
      secrets: {},
      logger: stubLogger,
    });

    const exec1 = environment.execute({
      eid: 34,
      code: infiniteCode,
      envConfig: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);
    const exec2 = environment.execute({
      eid: 35,
      code: "const queued = true;",
      envConfig: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);

    await sleep(10);
    await environment.kill(34);

    expect(await exec1).toBe("canceled");
    expect(await exec2).toBe("canceled");
    expect(
      setState.mock.calls.some(
        ([eid, state]) => eid === 35 && state === "running",
      ),
    ).toBe(false);
  });

  it("honours poolSize from config", async () => {
    const { bindings, setState } = createBindings();
    const environment = tsivm.instantiate();

    await environment.setup({
      bindings,
      config: { poolSize: 1 },
      secrets: {},
      logger: stubLogger,
    });

    const exec1 = environment.execute({
      eid: 41,
      code: infiniteCode,
      envConfig: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);
    const exec2 = environment.execute({
      eid: 42,
      code: infiniteCode,
      envConfig: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);

    await tick();

    expect(
      setState.mock.calls.some(
        ([eid, state]) => eid === 42 && state === "running",
      ),
    ).toBe(false);

    await environment.kill(41);
    await environment.kill(42);

    await Promise.all([exec1, exec2]);
  });

  it("rejects when queue exceeds maxQueueSize", async () => {
    const { bindings } = createBindings();
    const environment = tsivm.instantiate();

    await environment.setup({
      bindings,
      config: { poolSize: 1, maxQueueSize: 1 },
      secrets: {},
      logger: stubLogger,
    });

    const exec1 = environment.execute({
      eid: 51,
      code: infiniteCode,
      envConfig: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);
    const exec2 = environment.execute({
      eid: 52,
      code: infiniteCode,
      envConfig: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);

    await tick();

    await expect(
      environment.execute({
        eid: 53,
        code: "const x = 1;",
        envConfig: { timeoutMs: 30_000 },
      } satisfies ExecutionInput),
    ).rejects.toThrow(/queue is full/i);

    await environment.kill(51);
    await environment.kill(52);
    await Promise.all([exec1, exec2]);
  });

  it("lists every binding as disabled in docs by default", async () => {
    const { bindings } = createBindings();
    const environment = tsivm.instantiate();

    await environment.setup({
      bindings,
      config: {},
      secrets: {},
      logger: stubLogger,
    });

    const docs = await environment.generateDocs();

    expect(docs).toContain("## Optional bindings (currently disabled)");
    expect(docs).not.toContain("## Enabled optional bindings");
    expect(docs).toContain("btoa(str), atob(str) (base64 binding disabled)");
    expect(docs).toContain(
      "TextEncoder, TextDecoder (textCodecs binding disabled)",
    );
    expect(docs).toContain("URL, URLSearchParams (url binding disabled)");
    expect(docs).toContain(
      "setTimeout(cb, ms), setInterval(cb, ms), clearTimeout(id), clearInterval(id), queueMicrotask(cb) (timers binding disabled)",
    );
    expect(docs).toContain(
      "crypto.getRandomValues(typedArray), crypto.randomUUID() (randomValues binding disabled)",
    );
    expect(docs).toContain(
      "console.warn/info/debug/table/trace/time/count/group/assert and other methods (fullConsole binding disabled)",
    );
  });

  it("reflects enabled bindings in docs", async () => {
    const { bindings } = createBindings();
    const environment = tsivm.instantiate();

    await environment.setup({
      bindings,
      config: { bindings: { base64: true, fullConsole: true } },
      secrets: {},
      logger: stubLogger,
    });

    const docs = await environment.generateDocs();

    expect(docs).toContain(
      "## Enabled optional bindings (operator-configured)",
    );
    expect(docs).toContain("- **base64**: `btoa(str), atob(str)`");
    expect(docs).toContain("- **fullConsole**: `console.warn");
    expect(docs).toContain("textCodecs binding disabled");
    expect(docs).not.toContain("base64 binding disabled");
  });

  it("enabling url implies textCodecs in docs", async () => {
    const { bindings } = createBindings();
    const environment = tsivm.instantiate();

    await environment.setup({
      bindings,
      config: { bindings: { url: true } },
      secrets: {},
      logger: stubLogger,
    });

    const urlDocs = await environment.generateDocs();
    expect(urlDocs).toContain("URL");
    expect(urlDocs).toContain("- **textCodecs**: `TextEncoder, TextDecoder");
    expect(urlDocs).not.toContain("textCodecs binding disabled");
  });

  it("does not leak bindings between environments with different configs", async () => {
    const { bindings } = createBindings();
    const urlEnvironment = tsivm.instantiate();
    const base64Environment = tsivm.instantiate();

    await urlEnvironment.setup({
      bindings,
      config: { bindings: { url: true } },
      secrets: {},
      logger: stubLogger,
    });
    await base64Environment.setup({
      bindings,
      config: { bindings: { base64: true } },
      secrets: {},
      logger: stubLogger,
    });

    const urlResult = await urlEnvironment.execute({
      eid: 61,
      code: `const u = new URL("https://example.com/x");
console.log(typeof btoa === "undefined", u.pathname);`,
      envConfig: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);
    const base64Result = await base64Environment.execute({
      eid: 62,
      code: `console.log(typeof URL === "undefined", btoa("ok"));`,
      envConfig: { timeoutMs: 30_000 },
    } satisfies ExecutionInput);

    expect(urlResult).toBe("success");
    expect(base64Result).toBe("success");
    const stdout = bindings.emitStdout.mock.calls.map((call) =>
      call[1].toString("utf8"),
    );
    expect(stdout).toEqual(["true /x\n", "true b2s=\n"]);

    await urlEnvironment.teardown();
    await base64Environment.teardown();
  });
});
