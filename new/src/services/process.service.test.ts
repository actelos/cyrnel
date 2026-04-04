import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "@/logger";
import { HttpError } from "@/models/error.model";
import type {
  EnvironmentModule,
  EnvironmentOutputPatch,
  ExecutionStatus,
} from "@/modules/environment.module";
import { EnvironmentPoolService } from "@/services/pool.service";
import { ProcessService } from "@/services/process.service";

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

class TestEnvironmentModule extends EventEmitter {
  constructor(
    private readonly executeImpl: (
      code: string,
      options?: { timeoutMs?: number },
    ) => Promise<ExecutionStatus>,
    private readonly killImpl: () => Promise<void> = async () => {},
  ) {
    super();
  }

  async execute(
    code: string,
    options?: { timeoutMs?: number },
  ): Promise<ExecutionStatus> {
    return this.executeImpl(code, options);
  }

  async kill(): Promise<void> {
    await this.killImpl();
  }
}

class TestEnvironmentPoolService extends EnvironmentPoolService {
  constructor(private readonly allocateImpl: () => EnvironmentModule) {
    super();
  }

  override allocate(): EnvironmentModule {
    return this.allocateImpl();
  }
}

describe("ProcessService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("create() transitions queued -> running -> idle", async () => {
    const executeGate = deferred<ExecutionStatus>();
    const module = new TestEnvironmentModule(async () => executeGate.promise);
    const allocate = vi.fn(() => module as unknown as EnvironmentModule);
    const pool = new TestEnvironmentPoolService(allocate);
    const service = new ProcessService(pool);

    const pid = service.create("console.log('hi')", "ref-1");

    const created = service.get(pid);
    expect(created.pid).toBe(pid);
    expect(created.ref).toBe("ref-1");
    expect(created.status).toBeNull();
    expect(["queued", "running"]).toContain(created.state);

    await waitForState(service, pid, "running");

    executeGate.resolve("success");
    await waitForState(service, pid, "idle");

    expect(service.get(pid)).toMatchObject({
      pid,
      state: "idle",
      status: "success",
    });
    expect(allocate).toHaveBeenCalledTimes(1);
  });

  it("captures stdout, stderr, and output patches", async () => {
    const module = new TestEnvironmentModule(async () => {
      module.emit("stdout", Buffer.from("hello "));
      module.emit("stdout", Buffer.from("world"));
      module.emit("stderr", Buffer.from("warn"));
      module.emit("output", {
        key: "result",
        value: { ok: true },
      } as EnvironmentOutputPatch);
      module.emit("output", {
        key: "meta",
        value: 42,
      } as EnvironmentOutputPatch);
      return "success";
    });

    const pool = new TestEnvironmentPoolService(
      () => module as unknown as EnvironmentModule,
    );
    const service = new ProcessService(pool);

    const pid = service.create("code");
    await waitForState(service, pid, "idle");

    expect(service.getStdout(pid)).toBe("hello world");
    expect(service.getStderr(pid)).toBe("warn");
    expect(service.getOutput(pid)).toEqual({
      result: { ok: true },
      meta: 42,
    });
  });

  it("runs queued processes sequentially", async () => {
    const first = deferred<ExecutionStatus>();
    const second = deferred<ExecutionStatus>();
    const seenCodes: string[] = [];

    const module = new TestEnvironmentModule(async (code) => {
      seenCodes.push(code);
      if (seenCodes.length === 1) {
        return first.promise;
      }
      return second.promise;
    });

    const pool = new TestEnvironmentPoolService(
      () => module as unknown as EnvironmentModule,
    );
    const service = new ProcessService(pool);

    const pidA = service.create("A");
    const pidB = service.create("B");

    await waitForState(service, pidA, "running");
    expect(service.get(pidB).state).toBe("queued");

    first.resolve("success");
    await waitForState(service, pidA, "idle");
    await waitForState(service, pidB, "running");

    second.resolve("failed");
    await waitForState(service, pidB, "idle");

    expect(seenCodes).toEqual(["A", "B"]);
    expect(service.get(pidB).status).toBe("failed");
  });

  it("kill() marks a running process as terminating and invokes module kill", async () => {
    const executeGate = deferred<ExecutionStatus>();
    const kill = vi.fn(async () => {});
    const module = new TestEnvironmentModule(
      async () => executeGate.promise,
      kill,
    );

    const pool = new TestEnvironmentPoolService(
      () => module as unknown as EnvironmentModule,
    );
    const service = new ProcessService(pool);

    const pid = service.create("code");
    await waitForState(service, pid, "running");

    service.kill(pid);

    expect(service.get(pid).state).toBe("terminating");
    expect(kill).toHaveBeenCalledTimes(1);

    executeGate.reject(new Error("killed"));
    await waitForState(service, pid, "idle");

    expect(service.get(pid).status).toBe("canceled");
  });

  it("kill() cancels a queued process without executing it", async () => {
    const first = deferred<ExecutionStatus>();
    const execute = vi
      .fn<(code: string) => Promise<ExecutionStatus>>()
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => "success");

    const module = new TestEnvironmentModule(async (code) => execute(code));

    const pool = new TestEnvironmentPoolService(
      () => module as unknown as EnvironmentModule,
    );
    const service = new ProcessService(pool);

    const runningPid = service.create("run");
    const queuedPid = service.create("queued");

    await waitForState(service, runningPid, "running");
    expect(service.get(queuedPid).state).toBe("queued");

    service.kill(queuedPid);

    expect(service.get(queuedPid)).toMatchObject({
      pid: queuedPid,
      state: "idle",
      status: "canceled",
    });

    first.resolve("success");
    await waitForState(service, runningPid, "idle");
    await flush();

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("marks process timeout when execute exceeds timeout", async () => {
    vi.useFakeTimers();

    try {
      const executeGate = deferred<ExecutionStatus>();
      const module = new TestEnvironmentModule(async () => executeGate.promise);
      const pool = new TestEnvironmentPoolService(
        () => module as unknown as EnvironmentModule,
      );
      const service = new ProcessService(pool, { executeTimeoutMs: 50 });

      const pid = service.create("timeout");
      await waitForState(service, pid, "running");

      await vi.advanceTimersByTimeAsync(50);
      await flush();

      expect(service.get(pid)).toMatchObject({
        pid,
        state: "idle",
        status: "timeout",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks timeout during termination as canceled", async () => {
    vi.useFakeTimers();

    try {
      const executeGate = deferred<ExecutionStatus>();
      const kill = vi.fn(async () => {});
      const module = new TestEnvironmentModule(
        async () => executeGate.promise,
        kill,
      );
      const pool = new TestEnvironmentPoolService(
        () => module as unknown as EnvironmentModule,
      );
      const service = new ProcessService(pool, { executeTimeoutMs: 50 });

      const pid = service.create("timeout-after-kill");
      await waitForState(service, pid, "running");

      service.kill(pid);
      expect(service.get(pid).state).toBe("terminating");

      await vi.advanceTimersByTimeAsync(50);
      await flush();

      expect(kill).toHaveBeenCalledTimes(1);
      expect(service.get(pid)).toMatchObject({
        pid,
        state: "idle",
        status: "canceled",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("run() enforces force for existing outputs and resets data when forced", async () => {
    let runCount = 0;

    const module = new TestEnvironmentModule(async () => {
      runCount += 1;

      if (runCount === 1) {
        module.emit("stdout", Buffer.from("old-out"));
        module.emit("stderr", Buffer.from("old-err"));
        module.emit("output", {
          key: "old",
          value: true,
        } as EnvironmentOutputPatch);
      }

      return "success";
    });

    const pool = new TestEnvironmentPoolService(
      () => module as unknown as EnvironmentModule,
    );
    const service = new ProcessService(pool);

    const pid = service.create("code");
    await waitForState(service, pid, "idle");

    expect(service.getOutput(pid)).toEqual({ old: true });
    expect(service.getStdout(pid)).toBe("old-out");
    expect(service.getStderr(pid)).toBe("old-err");

    expect(() => service.run(pid, false)).toThrow(HttpError);

    service.run(pid, true);
    await waitForState(service, pid, "idle");

    expect(service.getOutput(pid)).toEqual({});
    expect(service.getStdout(pid)).toBe("");
    expect(service.getStderr(pid)).toBe("");
  });

  it("list() filters by state, status, and ref", () => {
    const module = new TestEnvironmentModule(async () => "success");
    const pool = new TestEnvironmentPoolService(
      () => module as unknown as EnvironmentModule,
    );
    const service = new ProcessService(pool);

    const pidA = service.create("a", "alpha");
    const pidB = service.create("b", "beta");
    const pidC = service.create("c", "beta");

    const processes = (
      service as unknown as {
        processes: Map<
          number,
          {
            process: {
              state: "queued" | "running" | "terminating" | "idle";
              status: "failed" | "success" | "timeout" | "canceled" | null;
            };
          }
        >;
      }
    ).processes;

    const a = processes.get(pidA);
    const b = processes.get(pidB);
    const c = processes.get(pidC);

    if (!a || !b || !c) {
      throw new Error("Expected stored processes to exist");
    }

    a.process.state = "idle";
    a.process.status = "success";

    b.process.state = "running";
    b.process.status = null;

    c.process.state = "idle";
    c.process.status = "failed";

    expect(service.list({})).toHaveLength(3);
    expect(
      service
        .list({ state: "idle" })
        .map((p) => p.pid)
        .sort(),
    ).toEqual([pidA, pidC]);
    expect(service.list({ status: "failed" }).map((p) => p.pid)).toEqual([
      pidC,
    ]);
    expect(
      service
        .list({ ref: "beta" })
        .map((p) => p.pid)
        .sort(),
    ).toEqual([pidB, pidC]);
  });

  it("guards output reads until idle and reuses pid after delete", async () => {
    const executeGate = deferred<ExecutionStatus>();
    const module = new TestEnvironmentModule(async () => executeGate.promise);
    const pool = new TestEnvironmentPoolService(
      () => module as unknown as EnvironmentModule,
    );
    const service = new ProcessService(pool);

    const pid = service.create("code");

    expect(() => service.getOutput(pid)).toThrow(HttpError);
    expect(() => service.getStdout(pid)).toThrow(HttpError);
    expect(() => service.getStderr(pid)).toThrow(HttpError);
    expect(() => service.delete(pid)).toThrow(HttpError);
    expect(() => service.get(999)).toThrow(HttpError);

    executeGate.resolve("success");
    await waitForState(service, pid, "idle");

    const removed = service.delete(pid);
    expect(removed.pid).toBe(pid);

    const reusedPid = service.create("next");
    expect(reusedPid).toBe(pid);
  });

  it("logs expected messages for timeout and execution failures", async () => {
    vi.useFakeTimers();

    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);

    try {
      const timeoutGate = deferred<ExecutionStatus>();
      const timeoutModule = new TestEnvironmentModule(
        async () => timeoutGate.promise,
      );
      const timeoutPool = new TestEnvironmentPoolService(
        () => timeoutModule as unknown as EnvironmentModule,
      );
      const timeoutService = new ProcessService(timeoutPool, {
        executeTimeoutMs: 25,
      });

      const timeoutPid = timeoutService.create("timeout");
      await waitForState(timeoutService, timeoutPid, "running");
      await vi.advanceTimersByTimeAsync(25);
      await waitForState(timeoutService, timeoutPid, "idle");

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ pid: timeoutPid }),
        "Process execution timed out",
      );

      const failedModule = new TestEnvironmentModule(async () => {
        throw new Error("boom");
      });
      const failedPool = new TestEnvironmentPoolService(
        () => failedModule as unknown as EnvironmentModule,
      );
      const failedService = new ProcessService(failedPool);

      const failedPid = failedService.create("fail");
      await waitForState(failedService, failedPid, "idle");

      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ pid: failedPid }),
        "Process execution failed",
      );
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
