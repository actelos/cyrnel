import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProcessService } from "@/services/process.service";
import { HttpError } from "@/models/error";
import { logger } from "@/logger";
import type { ExecutionStatus, EnvironmentModule } from "@/config/modules";
import type { Pool, PooledInstance } from "@/services/pool.service";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const waitForState = async (
  service: ProcessService,
  pid: number,
  state: "queued" | "running" | "terminating" | "idle",
): Promise<void> => {
  for (let i = 0; i < 100; i += 1) {
    if (service.get(pid).state === state) {
      return;
    }

    await flush();
  }

  throw new Error(
    `Timed out waiting for process ${pid} to reach state ${state}`,
  );
};

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

class TestEnvironmentModule extends EventEmitter implements EnvironmentModule {
  readonly type = "environment";
  readonly label = "test";

  constructor(
    private readonly executeImpl: (code: string) => Promise<ExecutionStatus>,
    private readonly killImpl: () => Promise<void> = async () => {},
  ) {
    super();
  }

  async setup(): Promise<void> {}

  async execute(code: string): Promise<ExecutionStatus> {
    return this.executeImpl(code);
  }

  async kill(): Promise<void> {
    await this.killImpl();
  }
}

const createMockPool = (
  acquireImpl: () => Promise<PooledInstance>,
): {
  pool: Pool;
  release: ReturnType<typeof vi.fn>;
  acquire: ReturnType<typeof vi.fn>;
} => {
  const acquire = vi.fn(acquireImpl);
  const release = vi.fn();

  return {
    pool: {
      instances: [],
      queue: [],
      initialize: vi.fn(),
      acquire,
      release,
    },
    release,
    acquire,
  };
};

const getStored = (service: ProcessService, pid: number) =>
  (service as any).processes.get(pid);

const setState = (
  service: ProcessService,
  pid: number,
  state: "queued" | "running" | "terminating" | "idle",
) => {
  const stored = getStored(service, pid);
  stored.process.state = state;
  return stored;
};

describe("ProcessService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("create() triggers async execution and transitions queued -> running -> idle", async () => {
    const executeGate = deferred<ExecutionStatus>();
    const module = new TestEnvironmentModule(async () => executeGate.promise);
    const instance: PooledInstance = { module, busy: true };
    const { pool, release } = createMockPool(async () => instance);
    const service = new ProcessService(pool);

    const pid = service.create("console.log('hi')", "abc");

    expect(getStored(service, pid).process.state).toBe("queued");

    await flush();
    expect(getStored(service, pid).process.state).toBe("running");

    executeGate.resolve("success");
    await waitForState(service, pid, "idle");

    const stored = getStored(service, pid);
    expect(stored.process.state).toBe("idle");
    expect(stored.process.status).toBe("success");
    expect(release).toHaveBeenCalledWith(instance);
  });

  it("create() appends stdout/stderr chunks and stores output events", async () => {
    const module = new TestEnvironmentModule(async () => {
      module.emit("stdout", Buffer.from("hello "));
      module.emit("stdout", Buffer.from("world"));
      module.emit("stderr", Buffer.from("warn"));
      module.emit("output", { ok: true });
      return "success";
    });
    const instance: PooledInstance = { module, busy: true };
    const { pool } = createMockPool(async () => instance);
    const service = new ProcessService(pool);

    const pid = service.create("code");
    await flush();

    const stored = getStored(service, pid);
    expect(stored.stdoutChunks).toEqual(["hello ", "world"]);
    expect(stored.stderrChunks).toEqual(["warn"]);
    expect(stored.output).toEqual({ ok: true });
  });

  it("create() sets final status from module execute()", async () => {
    const statuses: ExecutionStatus[] = [
      "success",
      "failed",
      "timeout",
      "canceled",
    ];

    for (const status of statuses) {
      const module = new TestEnvironmentModule(async () => status);
      const instance: PooledInstance = { module, busy: true };
      const { pool } = createMockPool(async () => instance);
      const service = new ProcessService(pool);

      const pid = service.create("code");
      await waitForState(service, pid, "idle");

      expect(service.get(pid).status).toBe(status);
      expect(service.get(pid).state).toBe("idle");
    }
  });

  it("kill() calls module.kill() when process is running", async () => {
    const executeGate = deferred<ExecutionStatus>();
    const kill = vi.fn(async () => {});
    const module = new TestEnvironmentModule(
      async () => executeGate.promise,
      kill,
    );
    const instance: PooledInstance = { module, busy: true };
    const { pool } = createMockPool(async () => instance);
    const service = new ProcessService(pool);

    const pid = service.create("code");
    await flush();
    expect(service.get(pid).state).toBe("running");

    service.kill(pid);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(service.get(pid).state).toBe("terminating");

    executeGate.resolve("canceled");
    await waitForState(service, pid, "idle");

    expect(service.get(pid).state).toBe("idle");
    expect(service.get(pid).status).toBe("canceled");
  });

  it("times out stuck execute() and releases instance", async () => {
    vi.useFakeTimers();

    try {
      const executeGate = deferred<ExecutionStatus>();
      const module = new TestEnvironmentModule(async () => executeGate.promise);
      const instance: PooledInstance = { module, busy: true };
      const { pool, release } = createMockPool(async () => instance);
      const service = new ProcessService(pool, { executeTimeoutMs: 50 });

      const pid = service.create("code");
      await flush();
      expect(service.get(pid).state).toBe("running");

      await vi.advanceTimersByTimeAsync(50);
      await flush();

      expect(service.get(pid).state).toBe("idle");
      expect(service.get(pid).status).toBe("timeout");
      expect(release).toHaveBeenCalledWith(instance);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out stuck terminating process and marks it canceled", async () => {
    vi.useFakeTimers();

    try {
      const executeGate = deferred<ExecutionStatus>();
      const kill = vi.fn(async () => {});
      const module = new TestEnvironmentModule(
        async () => executeGate.promise,
        kill,
      );
      const instance: PooledInstance = { module, busy: true };
      const { pool, release } = createMockPool(async () => instance);
      const service = new ProcessService(pool, { executeTimeoutMs: 50 });

      const pid = service.create("code");
      await flush();
      service.kill(pid);
      expect(service.get(pid).state).toBe("terminating");

      await vi.advanceTimersByTimeAsync(50);
      await flush();

      expect(kill).toHaveBeenCalledTimes(1);
      expect(service.get(pid).state).toBe("idle");
      expect(service.get(pid).status).toBe("canceled");
      expect(release).toHaveBeenCalledWith(instance);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats execute rejection during termination as canceled", async () => {
    const executeGate = deferred<ExecutionStatus>();
    const kill = vi.fn(async () => {});
    const module = new TestEnvironmentModule(
      async () => executeGate.promise,
      kill,
    );
    const instance: PooledInstance = { module, busy: true };
    const { pool } = createMockPool(async () => instance);
    const service = new ProcessService(pool);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);

    try {
      const pid = service.create("code");
      await flush();

      service.kill(pid);
      executeGate.reject(new Error("killed"));
      await waitForState(service, pid, "idle");

      expect(service.get(pid).state).toBe("idle");
      expect(service.get(pid).status).toBe("canceled");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ pid }),
        "Module threw during kill; treating as canceled",
      );
      expect(errorSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ pid }),
        "Process execution failed",
      );
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("marks execution rejection as failed when not terminating", async () => {
    const module = new TestEnvironmentModule(async () => {
      throw new Error("boom");
    });
    const instance: PooledInstance = { module, busy: true };
    const { pool } = createMockPool(async () => instance);
    const service = new ProcessService(pool);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);

    try {
      const pid = service.create("code");
      await waitForState(service, pid, "idle");

      expect(service.get(pid).state).toBe("idle");
      expect(service.get(pid).status).toBe("failed");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ pid }),
        "Process execution failed",
      );
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ pid }),
        "Module threw during kill; treating as canceled",
      );
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("kill() does not call module.kill() for queued process", async () => {
    const waitingAcquire = deferred<PooledInstance>();
    const kill = vi.fn(async () => {});
    const execute = vi.fn(async () => "success" as ExecutionStatus);
    const module = new TestEnvironmentModule(execute, kill);
    const instance: PooledInstance = { module, busy: true };
    const { pool } = createMockPool(async () => waitingAcquire.promise);
    const service = new ProcessService(pool);

    const pid = service.create("code");
    await flush();

    expect(service.get(pid).state).toBe("queued");

    service.kill(pid);

    expect(kill).not.toHaveBeenCalled();
    expect(service.get(pid).state).toBe("idle");
    expect(service.get(pid).status).toBe("canceled");

    waitingAcquire.resolve(instance);
    await flush();

    expect(execute).not.toHaveBeenCalled();
  });

  it("releases acquired instance only once when process is no longer queued", async () => {
    const waitingAcquire = deferred<PooledInstance>();
    const module = new TestEnvironmentModule(async () => "success");
    const instance: PooledInstance = { module, busy: true };
    const { pool, release } = createMockPool(
      async () => waitingAcquire.promise,
    );
    const service = new ProcessService(pool);

    const pid = service.create("code");
    await flush();

    service.kill(pid);
    expect(service.get(pid).state).toBe("idle");

    waitingAcquire.resolve(instance);
    await flush();

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(instance);
  });

  it("run() re-triggers execution for idle process", async () => {
    const module = new TestEnvironmentModule(async () => "success");
    const instance: PooledInstance = { module, busy: true };
    const { pool, acquire } = createMockPool(async () => instance);
    const service = new ProcessService(pool);

    const pid = service.create("code");
    await waitForState(service, pid, "idle");

    const stored = getStored(service, pid);
    stored.output = { prior: true };
    stored.stdoutChunks = ["prev"];
    stored.stderrChunks = ["prev-err"];

    service.run(pid, true);
    await waitForState(service, pid, "idle");

    const restarted = getStored(service, pid);

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(service.get(pid).state).toBe("idle");
    expect(service.get(pid).status).toBe("success");
    expect(restarted.output).toBeNull();
    expect(restarted.stdoutChunks).toEqual([]);
    expect(restarted.stderrChunks).toEqual([]);
  });

  it("removes module event listeners after execution completes", async () => {
    const module = new TestEnvironmentModule(async () => "success");
    const offSpy = vi.spyOn(module, "off");
    const instance: PooledInstance = { module, busy: true };
    const { pool } = createMockPool(async () => instance);
    const service = new ProcessService(pool);

    const pid = service.create("code");
    await waitForState(service, pid, "idle");

    expect(offSpy).toHaveBeenCalledWith("stdout", expect.any(Function));
    expect(offSpy).toHaveBeenCalledWith("stderr", expect.any(Function));
    expect(offSpy).toHaveBeenCalledWith("output", expect.any(Function));
    expect(module.listenerCount("stdout")).toBe(0);
    expect(module.listenerCount("stderr")).toBe(0);
    expect(module.listenerCount("output")).toBe(0);
  });

  it("lists processes with filters", async () => {
    const waitingAcquire = deferred<PooledInstance>();
    const module = new TestEnvironmentModule(async () => "success");
    const instance: PooledInstance = { module, busy: true };
    const { pool } = createMockPool(async () => waitingAcquire.promise);
    const service = new ProcessService(pool);

    const pidA = service.create("code-a", "alpha");
    const pidB = service.create("code-b", "beta");
    const pidC = service.create("code-c", "beta");

    setState(service, pidA, "idle").process.status = "success";
    setState(service, pidB, "running").process.status = null;
    setState(service, pidC, "idle").process.status = "failed";

    expect(service.list({})).toHaveLength(3);
    expect(
      service
        .list({ state: "idle" })
        .map((p) => p.pid)
        .sort((a, b) => a - b),
    ).toEqual([pidA, pidC].sort((a, b) => a - b));
    expect(service.list({ status: "failed" }).map((p) => p.pid)).toEqual([
      pidC,
    ]);
    expect(
      service
        .list({ ref: "beta" })
        .map((p) => p.pid)
        .sort((a, b) => a - b),
    ).toEqual([pidB, pidC].sort((a, b) => a - b));

    waitingAcquire.resolve(instance);
    await flush();
  });

  it("gets process and guards output access until idle", async () => {
    const waitingAcquire = deferred<PooledInstance>();
    const module = new TestEnvironmentModule(async () => "success");
    const instance: PooledInstance = { module, busy: true };
    const { pool } = createMockPool(async () => waitingAcquire.promise);
    const service = new ProcessService(pool);

    const pid = service.create("code");
    expect(service.get(pid).pid).toBe(pid);
    expect(() => service.get(999)).toThrow(HttpError);

    expect(() => service.getOutput(pid)).toThrow(HttpError);
    expect(() => service.getStdout(pid)).toThrow(HttpError);
    expect(() => service.getStderr(pid)).toThrow(HttpError);

    const stored = setState(service, pid, "idle");
    stored.output = { ok: true };
    stored.stdoutChunks = ["ok"];
    stored.stderrChunks = [];

    expect(service.getOutput(pid)).toEqual({ ok: true });
    expect(service.getStdout(pid)).toBe("ok");
    expect(service.getStderr(pid)).toBe("");

    waitingAcquire.resolve(instance);
    await flush();
  });

  it("run() throws when process is not idle", async () => {
    const waitingAcquire = deferred<PooledInstance>();
    const module = new TestEnvironmentModule(async () => "success");
    const instance: PooledInstance = { module, busy: true };
    const { pool } = createMockPool(async () => waitingAcquire.promise);
    const service = new ProcessService(pool);

    const pid = service.create("code");

    expect(() => service.run(pid, false)).toThrow(HttpError);

    waitingAcquire.resolve(instance);
    await flush();
  });

  it("run() enforces force when outputs already exist", async () => {
    const waitingAcquire = deferred<PooledInstance>();
    const module = new TestEnvironmentModule(async () => "success");
    const instance: PooledInstance = { module, busy: true };
    const { pool } = createMockPool(async () => waitingAcquire.promise);
    const service = new ProcessService(pool);

    const pid = service.create("code");

    const stored = setState(service, pid, "idle");
    stored.output = { prior: true };
    stored.stdoutChunks = ["log"];

    expect(() => service.run(pid, false)).toThrow(HttpError);

    waitingAcquire.resolve(instance);
    await flush();
  });

  it("deletes only idle processes and reuses pid", async () => {
    const waitingAcquire = deferred<PooledInstance>();
    const module = new TestEnvironmentModule(async () => "success");
    const instance: PooledInstance = { module, busy: true };
    const { pool } = createMockPool(async () => waitingAcquire.promise);
    const service = new ProcessService(pool);

    const pid = service.create("code");

    expect(() => service.delete(pid)).toThrow(HttpError);

    setState(service, pid, "idle");
    const removed = service.delete(pid);
    expect(removed.pid).toBe(pid);

    const newPid = service.create("next");
    expect(newPid).toBe(pid);

    waitingAcquire.resolve(instance);
    await flush();
  });
});
