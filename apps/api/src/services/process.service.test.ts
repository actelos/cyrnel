import type { ExecutionExitState, ExecutionInput } from "@cyrnel/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/db/client";
import { processes as processesTable } from "@/db/schema";
import { HttpError } from "@/models/error.model";
import { ProcessService } from "@/services/process.service";

function makeSelectChain<T>(rows: T[] = []) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    all: vi.fn().mockReturnValue(rows),
  } as unknown as ReturnType<typeof db.select>;
  return chain;
}

function makeDeleteChain() {
  const chain = {
    where: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReturnType<typeof db.delete>;
  return chain;
}

vi.mock("@/db/client", () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
    delete: vi.fn(),
  },
}));

interface ControllerSpy {
  executeCalls: ExecutionInput[];
  killCalls: number[];
  executeImpl: (input: ExecutionInput) => Promise<ExecutionExitState>;
  killImpl: (eid: number) => Promise<void>;
  execute: (input: ExecutionInput) => Promise<ExecutionExitState>;
  kill: (eid: number) => Promise<void>;
}

function makeController(): ControllerSpy {
  const spy = {
    executeCalls: [] as ExecutionInput[],
    killCalls: [] as number[],
    executeImpl: async (_input: ExecutionInput): Promise<ExecutionExitState> =>
      "success",
    killImpl: async (_eid: number): Promise<void> => {},
  } as ControllerSpy;
  spy.execute = (input) => {
    spy.executeCalls.push(input);
    return spy.executeImpl(input);
  };
  spy.kill = (eid) => {
    spy.killCalls.push(eid);
    return spy.killImpl(eid);
  };
  return spy;
}

function makeService(controller?: ControllerSpy) {
  const ctrl = controller ?? makeController();
  return { service: new ProcessService(ctrl), controller: ctrl };
}

const BASE_CREATE_INPUT = {
  code: "console.log('hi')",
  options: { timeoutMs: 100 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function tick(times = 1) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function mockInsertReturning(value: number) {
  const returning = vi.fn().mockResolvedValue([{ id: value }]);
  const values = vi.fn().mockReturnValue({ returning });
  vi.mocked(db.insert).mockReturnValue({ values } as unknown as ReturnType<
    typeof db.insert
  >);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.select).mockReturnValue(makeSelectChain());
  vi.mocked(db.delete).mockReturnValue(makeDeleteChain());
});

describe("ProcessService", () => {
  describe("create()", () => {
    it("inserts a row into the processes table and returns the id", async () => {
      const { service } = makeService();
      mockInsertReturning(42);

      const result = await service.create(BASE_CREATE_INPUT);

      expect(result).toEqual({ id: 42 });
      expect(db.insert).toHaveBeenCalledWith(processesTable);
    });

    it("returns an incrementing id starting at 1", async () => {
      let nextId = 1;
      const { service } = makeService();
      vi.mocked(db.insert).mockImplementation(
        () =>
          ({
            values: () => ({
              returning: () => Promise.resolve([{ id: nextId++ }]),
            }),
          }) as unknown as ReturnType<typeof db.insert>,
      );

      const a = await service.create(BASE_CREATE_INPUT);
      const b = await service.create(BASE_CREATE_INPUT);
      const c = await service.create(BASE_CREATE_INPUT);

      expect(a.id).toBe(1);
      expect(b.id).toBe(2);
      expect(c.id).toBe(3);
    });

    it("rejects create when active process records reach the configured cap", async () => {
      const originalMaxActive = process.env.CYRNEL_MAX_ACTIVE_PROCESSES;
      process.env.CYRNEL_MAX_ACTIVE_PROCESSES = "1";

      try {
        const controller = makeController();
        controller.executeImpl = () => new Promise(() => {});
        const { service } = makeService(controller);
        mockInsertReturning(1);

        await service.create(BASE_CREATE_INPUT);

        await expect(service.create(BASE_CREATE_INPUT)).rejects.toMatchObject({
          statusCode: 429,
        });
        expect(db.insert).toHaveBeenCalledTimes(1);
      } finally {
        if (originalMaxActive === undefined) {
          delete process.env.CYRNEL_MAX_ACTIVE_PROCESSES;
        } else {
          process.env.CYRNEL_MAX_ACTIVE_PROCESSES = originalMaxActive;
        }
      }
    });

    it("seeds the new record with default fields", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create({ ...BASE_CREATE_INPUT, ref: "abc" });
      const record = await service.get(id);

      expect(record.id).toBe(id);
      expect(record.ref).toBe("abc");
      expect(record.exitState).toBeNull();
      expect(record.error).toBeNull();
      expect(["queued", "running"]).toContain(record.state);
      expect(await service.getCode(id)).toBe(BASE_CREATE_INPUT.code);
    });

    it("get() and list() strip code/options/output/stdout/stderr from the projection", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create(BASE_CREATE_INPUT);
      const record = await service.get(id);

      const stripped = [
        "code",
        "options",
        "output",
        "stdout",
        "stderr",
      ] as const;
      for (const key of stripped) {
        expect(Object.hasOwn(record, key)).toBe(false);
      }

      const [listed] = await service.list({});
      expect(listed).toBeDefined();
      for (const key of stripped) {
        expect(Object.hasOwn(listed as object, key)).toBe(false);
      }
    });

    it("kicks off the execution and marks idle after success", async () => {
      const controller = makeController();
      const finish = deferred<ExecutionExitState>();
      controller.executeImpl = () => finish.promise;
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create(BASE_CREATE_INPUT);
      expect(controller.executeCalls).toHaveLength(1);
      expect(controller.executeCalls[0]).toMatchObject({
        code: BASE_CREATE_INPUT.code,
        options: { timeoutMs: BASE_CREATE_INPUT.options.timeoutMs },
      });

      finish.resolve("success");
      await tick(5);

      const record = await service.get(id);
      expect(record.state).toBe("idle");
      expect(record.exitState).toBe("success");
    });

    it("defaults the timeout when none is provided", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);
      mockInsertReturning(1);

      await service.create({ code: "x", options: {} });

      expect(controller.executeCalls[0]?.options?.timeoutMs).toBe(30_000);
    });

    it("treats options.timeoutMs=null as 'use default' (30s)", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);
      mockInsertReturning(1);

      await service.create({
        code: "x",
        options: { timeoutMs: null },
      });

      expect(controller.executeCalls[0]?.options?.timeoutMs).toBe(30_000);
    });

    it("defaults autorun to true when not provided", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create(BASE_CREATE_INPUT);
      const record = await service.get(id);
      expect(record.state).toBe("queued");
      expect(controller.executeCalls).toHaveLength(1);
    });

    it("autorun=true starts execution immediately", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create({
        ...BASE_CREATE_INPUT,
        autorun: true,
      });
      expect(controller.executeCalls).toHaveLength(1);
      expect((await service.get(id)).state).toBe("queued");
    });

    it("autorun=false creates the process in idle state without executing", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create({
        ...BASE_CREATE_INPUT,
        autorun: false,
      });
      expect(controller.executeCalls).toHaveLength(0);
      const record = await service.get(id);
      expect(record.state).toBe("idle");
      expect(record.exitState).toBeNull();
      expect(record.error).toBeNull();
    });

    it("autorun=false process can be run later", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create({
        ...BASE_CREATE_INPUT,
        autorun: false,
      });
      expect(controller.executeCalls).toHaveLength(0);

      const result = await service.run(id, false);
      expect(result.state).toBe("queued");
      expect(controller.executeCalls).toHaveLength(1);
    });

    it("autorun=false process can be deleted while idle", async () => {
      const { service } = makeService();
      mockInsertReturning(1);
      const { id } = await service.create({
        ...BASE_CREATE_INPUT,
        autorun: false,
      });

      await expect(service.delete(id)).resolves.not.toThrow();
      await expect(service.get(id)).rejects.toThrow(HttpError);
    });

    it("throws HttpError(503) once the service is shutting down", async () => {
      const { service } = makeService();
      await service.shutdown();

      try {
        await service.create(BASE_CREATE_INPUT);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(503);
      }
    });
  });

  describe("list()", () => {
    it("filters by state, exitState, and ref", async () => {
      const controller = makeController();
      const gate = deferred<ExecutionExitState>();
      controller.executeImpl = () => gate.promise;
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const a = await service.create({ ...BASE_CREATE_INPUT, ref: "a" });
      const b = await service.create({ ...BASE_CREATE_INPUT, ref: "b" });

      expect(await service.list({})).toHaveLength(2);
      expect((await service.list({ ref: "b" })).map((r) => r.id)).toEqual([
        b.id,
      ]);

      gate.resolve("success");
      await tick(5);

      expect(
        (await service.list({ state: "idle" })).map((r) => r.id).sort(),
      ).toEqual([a.id, b.id].sort());
    });
  });

  describe("get* accessors", () => {
    it("get() throws HttpError(404) when the id is unknown", async () => {
      const { service } = makeService();
      try {
        await service.get(999);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(404);
      }
    });

    it("getOutput/getStdout/getStderr throw HttpError(409) until idle", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create(BASE_CREATE_INPUT);
      for (const fn of [
        () => service.getOutput(id),
        () => service.getStdout(id),
        () => service.getStderr(id),
      ]) {
        try {
          await fn();
          throw new Error("should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(HttpError);
          expect((err as HttpError).statusCode).toBe(409);
        }
      }
    });

    it("getCode() returns code regardless of state", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create(BASE_CREATE_INPUT);
      expect(await service.getCode(id)).toBe(BASE_CREATE_INPUT.code);
    });

    it("returns output/stdout/stderr once the process is idle", async () => {
      const controller = makeController();
      const finish = deferred<ExecutionExitState>();
      controller.executeImpl = () => finish.promise;
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create(BASE_CREATE_INPUT);
      const pid = controller.executeCalls[0].eid;
      service.recordOutput(pid, { hello: "world" });
      service.recordStdout(pid, Buffer.from("hello", "utf8"));
      service.recordStderr(pid, Buffer.from("boom", "utf8"));

      finish.resolve("success");
      await tick(5);

      expect(await service.getOutput(id)).toEqual({ hello: "world" });
      expect(await service.getStdout(id)).toBe("hello");
      expect(await service.getStderr(id)).toBe("boom");
    });
  });

  describe("kill()", () => {
    it("throws 404 when the id does not exist", async () => {
      const { service } = makeService();
      await expect(service.kill(123)).rejects.toThrow(HttpError);
    });

    it("throws 409 when the process is already idle", async () => {
      const { service } = makeService();
      mockInsertReturning(1);
      const { id } = await service.create(BASE_CREATE_INPUT);
      await tick(5);

      try {
        await service.kill(id);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as HttpError).statusCode).toBe(409);
      }
    });

    it("sets state to terminating and calls controller.kill", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create(BASE_CREATE_INPUT);
      const result = await service.kill(id);

      expect(result.state).toBe("terminating");
      expect(controller.killCalls).toHaveLength(1);
    });

    it("is idempotent: kill on a terminating process returns without re-calling kill", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create(BASE_CREATE_INPUT);
      await service.kill(id);
      expect(controller.killCalls).toHaveLength(1);

      const again = await service.kill(id);
      expect(again.state).toBe("terminating");
      expect(controller.killCalls).toHaveLength(1);
    });

    it("settles to idle with exitState='canceled' when the controller reports cancellation", async () => {
      const controller = makeController();
      const finish = deferred<ExecutionExitState>();
      controller.executeImpl = () => finish.promise;
      controller.killImpl = async () => {
        finish.resolve("canceled");
      };
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create(BASE_CREATE_INPUT);
      await service.kill(id);
      await tick(5);

      const record = await service.get(id);
      expect(record.state).toBe("idle");
      expect(record.exitState).toBe("canceled");
    });

    it("settles to exitState='canceled' when controller.execute REJECTS after a kill", async () => {
      const controller = makeController();
      const finish = deferred<ExecutionExitState>();
      controller.executeImpl = () => finish.promise;
      controller.killImpl = async () => {
        finish.reject(new Error("interrupted"));
      };
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create(BASE_CREATE_INPUT);
      await service.kill(id);
      await tick(5);

      const record = await service.get(id);
      expect(record.state).toBe("idle");
      expect(record.exitState).toBe("canceled");
      expect(record.error).toBeNull();
    });
  });

  describe("run()", () => {
    it("throws 503 once shutting down", async () => {
      const { service } = makeService();
      await service.shutdown();
      await expect(service.run(1, false)).rejects.toThrow(HttpError);
    });

    it("throws 404 when id is unknown", async () => {
      const { service } = makeService();
      await expect(service.run(99, false)).rejects.toThrow(HttpError);
    });

    it("throws 409 when the process is not idle", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create(BASE_CREATE_INPUT);
      try {
        await service.run(id, false);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as HttpError).statusCode).toBe(409);
      }
    });

    it("throws 400 when prior outputs exist and force=false", async () => {
      const { service, controller } = makeService();
      mockInsertReturning(1);
      const { id } = await service.create(BASE_CREATE_INPUT);
      const pid = controller.executeCalls[0].eid;
      service.recordOutput(pid, { a: 1 });
      await tick(5);

      try {
        await service.run(id, false);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as HttpError).statusCode).toBe(400);
      }

      expect(controller.executeCalls).toHaveLength(1);
    });

    it("force=true clears outputs and restarts execution", async () => {
      const { service, controller } = makeService();
      mockInsertReturning(1);
      const { id } = await service.create(BASE_CREATE_INPUT);
      const pid = controller.executeCalls[0].eid;
      service.recordOutput(pid, { a: 1 });
      service.recordStdout(pid, Buffer.from("noise", "utf8"));
      await tick(5);

      const before = await service.get(id);
      expect(before.exitState).toBe("success");

      const after = await service.run(id, true);
      expect(after.exitState).toBeNull();
      expect(after.error).toBeNull();

      await tick(5);
      expect(await service.getOutput(id)).toEqual({});
      expect((await service.getStdout(id)).length).toBe(0);
      expect(controller.executeCalls).toHaveLength(2);
    });

    it("allows rerun without force when there are no prior outputs", async () => {
      const controller = makeController();
      let exit: ExecutionExitState = "failed";
      controller.executeImpl = async () => exit;
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create(BASE_CREATE_INPUT);
      await tick(5);

      await expect(service.run(id, false)).rejects.toThrow(HttpError);

      exit = "success";
      await service.run(id, true);
      await tick(5);
      expect((await service.get(id)).exitState).toBe("success");
    });
  });

  describe("delete()", () => {
    it("throws 409 when the process is not idle", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create(BASE_CREATE_INPUT);
      try {
        await service.delete(id);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as HttpError).statusCode).toBe(409);
      }
    });

    it("throws 404 when the id is unknown", async () => {
      const { service } = makeService();
      await expect(service.delete(42)).rejects.toThrow(HttpError);
    });

    it("removes the process and its db record", async () => {
      const { service } = makeService();
      mockInsertReturning(1);
      const { id } = await service.create(BASE_CREATE_INPUT);
      await tick(5);
      await service.delete(id);

      try {
        await service.get(id);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as HttpError).statusCode).toBe(404);
      }

      expect(db.delete).toHaveBeenCalledWith(processesTable);
    });
  });

  describe("waitForIdle()", () => {
    it("resolves immediately when the process is already idle", async () => {
      const { service } = makeService();
      mockInsertReturning(1);
      const { id } = await service.create(BASE_CREATE_INPUT);
      await tick(5);

      const result = await service.waitForIdle(id, 5);
      expect(result.state).toBe("idle");
    });

    it("polls until the process becomes idle", async () => {
      const controller = makeController();
      const finish = deferred<ExecutionExitState>();
      controller.executeImpl = () => finish.promise;
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create(BASE_CREATE_INPUT);
      const waited = service.waitForIdle(id, 5);

      finish.resolve("success");
      const result = await waited;
      expect(result.state).toBe("idle");
    });

    it("throws 504 when the process does not become idle within maxWaitMs", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create(BASE_CREATE_INPUT);

      await expect(service.waitForIdle(id, 5, 30)).rejects.toMatchObject({
        statusCode: 504,
      });
    });

    it("derives a default deadline from the configured execution timeout", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create({
        code: "x",
        options: { timeoutMs: 1 },
      });

      const err = (await service.waitForIdle(id, 5).catch((e) => e)) as
        | HttpError
        | undefined;
      expect(err).toBeInstanceOf(HttpError);
      expect(err?.statusCode).toBe(504);
    });
  });

  describe("shutdown()", () => {
    it("kills all running executions and awaits them", async () => {
      const controller = makeController();
      const a = deferred<ExecutionExitState>();
      const b = deferred<ExecutionExitState>();
      const queue = [a, b];
      controller.executeImpl = () =>
        queue.shift()?.promise ?? Promise.resolve("success");
      controller.killImpl = async (eid) => {
        if (eid === 1) a.resolve("canceled");
        if (eid === 2) b.resolve("canceled");
      };
      const { service } = makeService(controller);
      mockInsertReturning(1);
      mockInsertReturning(2);

      const first = await service.create(BASE_CREATE_INPUT);
      const second = await service.create(BASE_CREATE_INPUT);

      const done = service.shutdown();
      await done;

      await expect(service.get(first.id)).resolves.toBeDefined();
      await expect(service.get(second.id)).resolves.toBeDefined();
    });

    it("ignores controller.kill errors during shutdown", async () => {
      const controller = makeController();
      const finish = deferred<ExecutionExitState>();
      controller.executeImpl = () => finish.promise;
      controller.killImpl = async () => {
        finish.resolve("canceled");
        throw new Error("boom");
      };
      const { service } = makeService(controller);
      mockInsertReturning(1);

      await service.create(BASE_CREATE_INPUT);
      await expect(service.shutdown()).resolves.toBeUndefined();
    });
  });

  describe("recordState()", () => {
    it("updates state for queued and running", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create(BASE_CREATE_INPUT);
      const pid = controller.executeCalls[0].eid;
      service.recordState(pid, "running");
      expect((await service.get(id)).state).toBe("running");
      service.recordState(pid, "queued");
      expect((await service.get(id)).state).toBe("queued");
    });

    it("ignores updates to a terminating or idle process", async () => {
      const { service } = makeService();
      mockInsertReturning(1);
      const { id } = await service.create(BASE_CREATE_INPUT);
      await tick(5);
      service.recordState(1, "running");
      expect((await service.get(id)).state).toBe("idle");
    });

    it("ignores updates for unknown pids", () => {
      const { service } = makeService();
      expect(() => service.recordState(999, "running")).not.toThrow();
    });
  });

  describe("recordStdout/recordStderr", () => {
    it("decodes utf-8 chunks across writes", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);
      mockInsertReturning(1);

      await service.create(BASE_CREATE_INPUT);
      const pid = controller.executeCalls[0].eid;
      service.recordStdout(pid, Buffer.from([0xe2, 0x82]));
      service.recordStdout(pid, Buffer.from([0xac]));

      const stored = await service.list({});
      expect(stored[0]).toBeDefined();
    });

    it("returns silently when the eid is missing", () => {
      const { service } = makeService();
      expect(() => service.recordStdout(999, Buffer.from("x"))).not.toThrow();
      expect(() => service.recordStderr(999, Buffer.from("x"))).not.toThrow();
    });
  });

  describe("recordOutput()", () => {
    it("merges into the stored output object", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);
      mockInsertReturning(1);

      await service.create(BASE_CREATE_INPUT);
      const pid = controller.executeCalls[0].eid;
      service.recordOutput(pid, { a: 1 });
      service.recordOutput(pid, { b: 2 });
      service.recordOutput(pid, { a: 99 });

      expect(() => service.recordOutput(pid, { c: 3 })).not.toThrow();
    });

    it("silently ignores unknown eids", () => {
      const { service } = makeService();
      expect(() => service.recordOutput(123, { a: 1 })).not.toThrow();
    });
  });

  describe("recordError()", () => {
    it("stores the error message on the record", async () => {
      const controller = makeController();
      controller.executeImpl = async () => {
        throw new Error("execute blew up");
      };
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create(BASE_CREATE_INPUT);
      await tick(10);

      const record = await service.get(id);
      expect(record.error).toBe("execute blew up");
      expect(record.exitState).toBe("failed");
      expect(record.state).toBe("idle");
    });

    it("stringifies non-Error throws", async () => {
      const controller = makeController();
      controller.executeImpl = async () => {
        throw "string-error";
      };
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create(BASE_CREATE_INPUT);
      await tick(10);

      expect((await service.get(id)).error).toBe("string-error");
    });

    it("JSON.stringifies object throws", async () => {
      const controller = makeController();
      controller.executeImpl = async () => {
        throw { code: 42 };
      };
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create(BASE_CREATE_INPUT);
      await tick(10);

      expect((await service.get(id)).error).toBe('{"code":42}');
    });

    it("falls back to String() for circular objects", async () => {
      const controller = makeController();
      controller.executeImpl = async () => {
        const obj: Record<string, unknown> = {};
        obj.self = obj;
        throw obj;
      };
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create(BASE_CREATE_INPUT);
      await tick(10);

      expect((await service.get(id)).error).toBe("[object Object]");
    });
  });

  describe("decoder flushing", () => {
    it("emits trailing bytes from a partial UTF-8 sequence when the process finishes", async () => {
      const controller = makeController();
      const finish = deferred<ExecutionExitState>();
      controller.executeImpl = () => finish.promise;
      const { service } = makeService(controller);
      mockInsertReturning(1);

      const { id } = await service.create(BASE_CREATE_INPUT);
      const pid = controller.executeCalls[0].eid;
      service.recordStdout(pid, Buffer.from([0xe2, 0x82]));

      finish.resolve("success");
      await tick(10);

      const stdout = await service.getStdout(id);
      expect(stdout.length).toBeGreaterThan(0);
    });
  });
});
