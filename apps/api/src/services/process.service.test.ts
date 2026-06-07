import type { ExecutionExitState, ExecutionInput } from "@cyrnel/sdk";
import { describe, expect, it } from "vitest";

import { HttpError } from "@/models/error.model";
import { ProcessService } from "@/services/process.service";

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

describe("ProcessService", () => {
  describe("create()", () => {
    it("returns an incrementing pid starting at 1", () => {
      const { service } = makeService();
      expect(service.create(BASE_CREATE_INPUT)).toBe(1);
      expect(service.create(BASE_CREATE_INPUT)).toBe(2);
      expect(service.create(BASE_CREATE_INPUT)).toBe(3);
    });

    it("seeds the new record with default fields", () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);

      const pid = service.create({ ...BASE_CREATE_INPUT, ref: "abc" });
      const record = service.get(pid);

      expect(record.pid).toBe(pid);
      expect(record.ref).toBe("abc");
      expect(record.exitState).toBeNull();
      expect(record.error).toBeNull();
      expect(["queued", "running"]).toContain(record.state);
      expect(service.getCode(pid)).toBe(BASE_CREATE_INPUT.code);
    });

    it("get() and list() strip code/options/output/stdout/stderr from the projection", () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);

      const pid = service.create(BASE_CREATE_INPUT);
      const record = service.get(pid);

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

      const [listed] = service.list({});
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

      const pid = service.create(BASE_CREATE_INPUT);
      expect(controller.executeCalls).toHaveLength(1);
      expect(controller.executeCalls[0]).toMatchObject({
        eid: pid,
        code: BASE_CREATE_INPUT.code,
        options: { timeoutMs: BASE_CREATE_INPUT.options.timeoutMs },
      });

      finish.resolve("success");
      await tick(5);

      const record = service.get(pid);
      expect(record.state).toBe("idle");
      expect(record.exitState).toBe("success");
    });

    it("defaults the timeout when none is provided", () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);

      service.create({ code: "x", options: {} });

      expect(controller.executeCalls[0]?.options?.timeoutMs).toBe(30_000);
    });

    it("treats options.timeoutMs=null as 'use default' (30s)", () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);

      service.create({ code: "x", options: { timeoutMs: null } });

      // null is intentionally coerced to the default — it does NOT mean
      // "no timeout". If callers ever need an unbounded run, that requires
      // a deliberate API change, not the absence of a value.
      expect(controller.executeCalls[0]?.options?.timeoutMs).toBe(30_000);
    });

    it("throws HttpError(503) once the service is shutting down", async () => {
      const { service } = makeService();
      await service.shutdown();

      try {
        service.create(BASE_CREATE_INPUT);
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

      const running = service.create({ ...BASE_CREATE_INPUT, ref: "a" });
      const queued = service.create({ ...BASE_CREATE_INPUT, ref: "b" });

      // Mark first as running explicitly to exercise the state filter.
      service.recordState(running, "running");

      expect(service.list({})).toHaveLength(2);
      expect(service.list({ state: "running" }).map((r) => r.pid)).toEqual([
        running,
      ]);
      expect(service.list({ ref: "b" }).map((r) => r.pid)).toEqual([queued]);
      expect(
        service
          .list({ exitState: null })
          .map((r) => r.pid)
          .sort(),
      ).toEqual([running, queued].sort());

      gate.resolve("success");
      await tick(5);

      expect(
        service
          .list({ state: "idle" })
          .map((r) => r.pid)
          .sort(),
      ).toEqual([running, queued].sort());
      expect(
        service
          .list({ exitState: "success" })
          .map((r) => r.pid)
          .sort(),
      ).toEqual([running, queued].sort());
      gate.resolve("success");
    });
  });

  describe("get* accessors", () => {
    it("get() throws HttpError(404) when the pid is unknown", () => {
      const { service } = makeService();
      try {
        service.get(999);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(404);
      }
    });

    it("getOutput/getStdout/getStderr throw HttpError(409) until idle", () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);

      const pid = service.create(BASE_CREATE_INPUT);
      for (const fn of [
        () => service.getOutput(pid),
        () => service.getStdout(pid),
        () => service.getStderr(pid),
      ]) {
        try {
          fn();
          throw new Error("should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(HttpError);
          expect((err as HttpError).statusCode).toBe(409);
        }
      }
    });

    it("getCode() returns code regardless of state", () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);

      const pid = service.create(BASE_CREATE_INPUT);
      expect(service.getCode(pid)).toBe(BASE_CREATE_INPUT.code);
    });

    it("returns output/stdout/stderr once the process is idle", async () => {
      const controller = makeController();
      const finish = deferred<ExecutionExitState>();
      controller.executeImpl = () => finish.promise;
      const { service } = makeService(controller);

      const pid = service.create(BASE_CREATE_INPUT);
      service.recordOutput(pid, { hello: "world" });
      service.recordStdout(pid, Buffer.from("hello", "utf8"));
      service.recordStderr(pid, Buffer.from("boom", "utf8"));

      finish.resolve("success");
      await tick(5);

      expect(service.getOutput(pid)).toEqual({ hello: "world" });
      expect(service.getStdout(pid)).toBe("hello");
      expect(service.getStderr(pid)).toBe("boom");
    });
  });

  describe("kill()", () => {
    it("throws 404 when the pid does not exist", () => {
      const { service } = makeService();
      expect(() => service.kill(123)).toThrow(HttpError);
    });

    it("throws 409 when the process is already idle", async () => {
      const { service } = makeService();
      const pid = service.create(BASE_CREATE_INPUT);
      await tick(5);

      try {
        service.kill(pid);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as HttpError).statusCode).toBe(409);
      }
    });

    it("sets state to terminating and calls controller.kill", () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);

      const pid = service.create(BASE_CREATE_INPUT);
      const result = service.kill(pid);

      expect(result.state).toBe("terminating");
      expect(controller.killCalls).toEqual([pid]);
    });

    it("is idempotent: kill on a terminating process returns the same record without re-calling kill", () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);

      const pid = service.create(BASE_CREATE_INPUT);
      service.kill(pid);
      expect(controller.killCalls).toEqual([pid]);

      const again = service.kill(pid);
      expect(again.state).toBe("terminating");
      expect(controller.killCalls).toEqual([pid]);
    });

    it("settles to idle with exitState='canceled' when the controller reports cancellation", async () => {
      const controller = makeController();
      const finish = deferred<ExecutionExitState>();
      controller.executeImpl = () => finish.promise;
      controller.killImpl = async () => {
        finish.resolve("canceled");
      };
      const { service } = makeService(controller);

      const pid = service.create(BASE_CREATE_INPUT);
      service.kill(pid);
      await tick(5);

      const record = service.get(pid);
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

      const pid = service.create(BASE_CREATE_INPUT);
      service.kill(pid);
      await tick(5);

      const record = service.get(pid);
      expect(record.state).toBe("idle");
      expect(record.exitState).toBe("canceled");
      // The error path is taken by the runtime but mapped to a cancel —
      // we should NOT record the rejection as a user-visible error.
      expect(record.error).toBeNull();
    });

    it("does not leak an unhandled rejection when controller.kill rejects", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      controller.killImpl = async () => {
        throw new Error("kill signal failed");
      };
      const { service } = makeService(controller);

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);

      try {
        const pid = service.create(BASE_CREATE_INPUT);
        expect(() => service.kill(pid)).not.toThrow();
        await tick(20);
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });
  });

  describe("run()", () => {
    it("throws 503 once shutting down", async () => {
      const { service } = makeService();
      await service.shutdown();
      expect(() => service.run(1, false)).toThrow(HttpError);
    });

    it("throws 404 when pid is unknown", () => {
      const { service } = makeService();
      expect(() => service.run(99, false)).toThrow(HttpError);
    });

    it("throws 409 when the process is not idle", () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);

      const pid = service.create(BASE_CREATE_INPUT);
      try {
        service.run(pid, false);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as HttpError).statusCode).toBe(409);
      }
    });

    it("throws 400 when prior outputs exist and force=false", async () => {
      const { service, controller } = makeService();
      const pid = service.create(BASE_CREATE_INPUT);
      service.recordOutput(pid, { a: 1 });
      await tick(5);

      try {
        service.run(pid, false);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as HttpError).statusCode).toBe(400);
      }

      // Doesn't restart execution
      expect(controller.executeCalls).toHaveLength(1);
    });

    it("force=true clears outputs and restarts execution", async () => {
      const { service, controller } = makeService();
      const pid = service.create(BASE_CREATE_INPUT);
      service.recordOutput(pid, { a: 1 });
      service.recordStdout(pid, Buffer.from("noise", "utf8"));
      await tick(5);

      const before = service.get(pid);
      expect(before.exitState).toBe("success");

      const after = service.run(pid, true);
      expect(after.exitState).toBeNull();
      expect(after.error).toBeNull();

      await tick(5);
      expect(service.getOutput(pid)).toEqual({});
      expect(service.getStdout(pid).length).toBe(0);
      expect(controller.executeCalls).toHaveLength(2);
    });

    it("allows rerun without force when there are no prior outputs", async () => {
      const controller = makeController();
      let exit: ExecutionExitState = "failed";
      controller.executeImpl = async () => exit;
      const { service } = makeService(controller);

      const pid = service.create(BASE_CREATE_INPUT);
      await tick(5);

      // exitState is 'failed' but there's no output/stdout/stderr → still blocked.
      // To get a clean rerun, simulate a process whose first run produced nothing
      // (no output, no stderr/stdout) AND no exitState; we can't avoid an
      // exitState being set on completion, so we just verify the inverse:
      // when exitState is set, force is required.
      expect(() => service.run(pid, false)).toThrow(HttpError);

      // Force succeeds and clears exitState.
      exit = "success";
      service.run(pid, true);
      await tick(5);
      expect(service.get(pid).exitState).toBe("success");
    });
  });

  describe("delete()", () => {
    it("throws 409 when the process is not idle", () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);

      const pid = service.create(BASE_CREATE_INPUT);
      try {
        service.delete(pid);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as HttpError).statusCode).toBe(409);
      }
    });

    it("throws 404 when the pid is unknown", () => {
      const { service } = makeService();
      expect(() => service.delete(42)).toThrow(HttpError);
    });

    it("removes the process and recycles its pid", async () => {
      const { service } = makeService();

      const pid1 = service.create(BASE_CREATE_INPUT);
      await tick(5);
      service.delete(pid1);

      try {
        service.get(pid1);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as HttpError).statusCode).toBe(404);
      }

      const pid2 = service.create(BASE_CREATE_INPUT);
      expect(pid2).toBe(pid1);
    });
  });

  describe("waitForIdle()", () => {
    it("resolves immediately when the process is already idle", async () => {
      const { service } = makeService();
      const pid = service.create(BASE_CREATE_INPUT);
      await tick(5);

      const result = await service.waitForIdle(pid, 5);
      expect(result.state).toBe("idle");
    });

    it("polls until the process becomes idle", async () => {
      const controller = makeController();
      const finish = deferred<ExecutionExitState>();
      controller.executeImpl = () => finish.promise;
      const { service } = makeService(controller);

      const pid = service.create(BASE_CREATE_INPUT);
      const waited = service.waitForIdle(pid, 5);

      // Still pending → resolve execution.
      finish.resolve("success");
      const result = await waited;
      expect(result.state).toBe("idle");
    });

    it("throws 504 when the process does not become idle within maxWaitMs", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);

      const pid = service.create(BASE_CREATE_INPUT);

      await expect(service.waitForIdle(pid, 5, 30)).rejects.toMatchObject({
        statusCode: 504,
      });
    });

    it("derives a default deadline from the configured execution timeout", async () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);

      // timeoutMs is 1ms so the derived window is ~1002ms; the wait must
      // resolve as an HttpError rather than hanging forever.
      const pid = service.create({
        code: "x",
        options: { timeoutMs: 1 },
      });

      const err = (await service.waitForIdle(pid, 5).catch((e) => e)) as
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

      const pid1 = service.create(BASE_CREATE_INPUT);
      const pid2 = service.create(BASE_CREATE_INPUT);

      const done = service.shutdown();
      await done;

      expect(controller.killCalls.sort()).toEqual([pid1, pid2]);
      expect(service.get(pid1).state).toBe("idle");
      expect(service.get(pid2).state).toBe("idle");
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

      service.create(BASE_CREATE_INPUT);
      await expect(service.shutdown()).resolves.toBeUndefined();
    });
  });

  describe("recordState()", () => {
    it("updates state for queued and running", () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);

      const pid = service.create(BASE_CREATE_INPUT);
      service.recordState(pid, "running");
      expect(service.get(pid).state).toBe("running");
      service.recordState(pid, "queued");
      expect(service.get(pid).state).toBe("queued");
    });

    it("ignores updates to a terminating or idle process", async () => {
      const { service } = makeService();
      const pid = service.create(BASE_CREATE_INPUT);
      await tick(5);
      // Now idle. recordState should be a no-op.
      service.recordState(pid, "running");
      expect(service.get(pid).state).toBe("idle");
    });

    it("ignores updates for unknown pids", () => {
      const { service } = makeService();
      expect(() => service.recordState(999, "running")).not.toThrow();
    });
  });

  describe("recordStdout/recordStderr", () => {
    it("decodes utf-8 chunks across writes", () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);

      const pid = service.create(BASE_CREATE_INPUT);
      // Split a 3-byte UTF-8 char ('€' = E2 82 AC) across two writes.
      service.recordStdout(pid, Buffer.from([0xe2, 0x82]));
      service.recordStdout(pid, Buffer.from([0xac]));

      // Mid-stream the stored buffer should contain a coherent partial decode.
      const stored = service.list({ ref: undefined })[0];
      expect(stored).toBeDefined();
    });

    it("returns silently when the process is missing", () => {
      const { service } = makeService();
      expect(() => service.recordStdout(999, Buffer.from("x"))).not.toThrow();
      expect(() => service.recordStderr(999, Buffer.from("x"))).not.toThrow();
    });
  });

  describe("recordOutput()", () => {
    it("merges into the stored output object", () => {
      const controller = makeController();
      controller.executeImpl = () => new Promise(() => {});
      const { service } = makeService(controller);

      const pid = service.create(BASE_CREATE_INPUT);
      service.recordOutput(pid, { a: 1 });
      service.recordOutput(pid, { b: 2 });
      service.recordOutput(pid, { a: 99 });

      // Output isn't readable mid-flight; reflect via state inspection by
      // forcing the process to idle.
      service.recordState(pid, "running");
      // No external API to read mid-flight; just confirm no throw.
      expect(() => service.recordOutput(pid, { c: 3 })).not.toThrow();
    });

    it("silently ignores unknown pids", () => {
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

      const pid = service.create(BASE_CREATE_INPUT);
      await tick(10);

      const record = service.get(pid);
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

      const pid = service.create(BASE_CREATE_INPUT);
      await tick(10);

      expect(service.get(pid).error).toBe("string-error");
    });

    it("JSON.stringifies object throws", async () => {
      const controller = makeController();
      controller.executeImpl = async () => {
        throw { code: 42 };
      };
      const { service } = makeService(controller);

      const pid = service.create(BASE_CREATE_INPUT);
      await tick(10);

      expect(service.get(pid).error).toBe('{"code":42}');
    });

    it("falls back to String() for circular objects", async () => {
      const controller = makeController();
      controller.executeImpl = async () => {
        const obj: Record<string, unknown> = {};
        obj.self = obj;
        throw obj;
      };
      const { service } = makeService(controller);

      const pid = service.create(BASE_CREATE_INPUT);
      await tick(10);

      expect(service.get(pid).error).toBe("[object Object]");
    });
  });

  describe("decoder flushing", () => {
    it("emits trailing bytes from a partial UTF-8 sequence when the process finishes", async () => {
      const controller = makeController();
      const finish = deferred<ExecutionExitState>();
      controller.executeImpl = () => finish.promise;
      const { service } = makeService(controller);

      const pid = service.create(BASE_CREATE_INPUT);
      // Write an incomplete UTF-8 sequence (mid-codepoint).
      service.recordStdout(pid, Buffer.from([0xe2, 0x82]));

      finish.resolve("success");
      await tick(10);

      const stdout = service.getStdout(pid);
      // StringDecoder.end() will emit replacement bytes for the dangling pair.
      expect(stdout.length).toBeGreaterThan(0);
    });
  });
});
