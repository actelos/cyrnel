import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createProcess,
  deleteProcess,
  getProcess,
  getProcessCode,
  getProcessOutput,
  getProcessStderr,
  getProcessStdout,
  killProcess,
  listProcesses,
  runProcess,
} from "@/controllers/process.controller";
import { HttpError } from "@/models/error.model";

const processService = {
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  getOutput: vi.fn(),
  getCode: vi.fn(),
  getStdout: vi.fn(),
  getStderr: vi.fn(),
  waitForIdle: vi.fn(),
  kill: vi.fn(),
  delete: vi.fn(),
  run: vi.fn(),
};

interface MockResponse {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  type: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

const makeRes = (): MockResponse => {
  const res = {} as MockResponse;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.type = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
};

const makeReq = (overrides: Record<string, unknown> = {}): Request =>
  ({
    app: { locals: { processService } },
    query: {},
    params: {},
    body: {},
    ...overrides,
  }) as unknown as Request;

const cast = (res: MockResponse) => res as unknown as Response;

describe("process.controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("locals wiring", () => {
    it("throws if processService is missing from app.locals", () => {
      const res = makeRes();
      const req = {
        app: { locals: {} },
        query: {},
        params: {},
        body: {},
      } as unknown as Request;

      expect(() => listProcesses(req, cast(res))).toThrow(
        /ProcessService not configured/,
      );
    });
  });

  describe("listProcesses", () => {
    it("forwards an empty filter when no query params are supplied", () => {
      const res = makeRes();
      processService.list.mockReturnValue([]);

      listProcesses(makeReq(), cast(res));

      expect(processService.list).toHaveBeenCalledWith({
        ref: undefined,
        state: undefined,
        exitState: undefined,
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ processes: [] });
    });

    it("parses state, status, and ref query params", () => {
      const res = makeRes();
      processService.list.mockReturnValue([{ pid: 1 }]);

      listProcesses(
        makeReq({
          query: { state: "queued", status: "success", ref: "  hello " },
        }),
        cast(res),
      );

      expect(processService.list).toHaveBeenCalledWith({
        ref: "hello",
        state: "queued",
        exitState: "success",
      });
      expect(res.json).toHaveBeenCalledWith({ processes: [{ pid: 1 }] });
    });

    it("maps status='null' to exitState=null", () => {
      const res = makeRes();
      processService.list.mockReturnValue([]);

      listProcesses(makeReq({ query: { status: "null" } }), cast(res));

      expect(processService.list).toHaveBeenCalledWith({
        ref: undefined,
        state: undefined,
        exitState: null,
      });
    });

    it.each([
      "running",
      "queued",
      "idle",
      "terminating",
    ])("accepts state %s", (state) => {
      const res = makeRes();
      processService.list.mockReturnValue([]);

      listProcesses(makeReq({ query: { state } }), cast(res));

      expect(processService.list).toHaveBeenCalledWith(
        expect.objectContaining({ state }),
      );
    });

    it.each([
      "success",
      "failed",
      "timeout",
      "canceled",
    ])("accepts status %s", (status) => {
      const res = makeRes();
      processService.list.mockReturnValue([]);

      listProcesses(makeReq({ query: { status } }), cast(res));

      expect(processService.list).toHaveBeenCalledWith(
        expect.objectContaining({ exitState: status }),
      );
    });

    it("rejects invalid state", () => {
      const res = makeRes();
      expect(() =>
        listProcesses(makeReq({ query: { state: "bogus" } }), cast(res)),
      ).toThrow(HttpError);
    });

    it("rejects invalid status", () => {
      const res = makeRes();
      expect(() =>
        listProcesses(makeReq({ query: { status: "bogus" } }), cast(res)),
      ).toThrow(HttpError);
    });

    it("rejects an empty ref string after trim", () => {
      const res = makeRes();
      expect(() =>
        listProcesses(makeReq({ query: { ref: "   " } }), cast(res)),
      ).toThrow(HttpError);
    });
  });

  describe("createProcess", () => {
    it("creates a process from a minimal body", async () => {
      const res = makeRes();
      processService.create.mockReturnValue(42);

      await createProcess(
        makeReq({ body: { code: "console.log(1)" } }),
        cast(res),
      );

      expect(processService.create).toHaveBeenCalledWith({
        ref: undefined,
        code: "console.log(1)",
        options: { timeoutMs: undefined },
      });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ pid: 42 });
      expect(processService.waitForIdle).not.toHaveBeenCalled();
    });

    it("includes ref and timeout from the body", async () => {
      const res = makeRes();
      processService.create.mockReturnValue(7);

      await createProcess(
        makeReq({
          body: {
            code: "x",
            ref: "  job-1  ",
            options: { timeout: 5000 },
          },
        }),
        cast(res),
      );

      expect(processService.create).toHaveBeenCalledWith({
        ref: "job-1",
        code: "x",
        options: { timeoutMs: 5000 },
      });
    });

    it("allows null timeout", async () => {
      const res = makeRes();
      processService.create.mockReturnValue(9);

      await createProcess(
        makeReq({ body: { code: "x", options: { timeout: null } } }),
        cast(res),
      );

      expect(processService.create).toHaveBeenCalledWith({
        ref: undefined,
        code: "x",
        options: { timeoutMs: null },
      });
    });

    it("returns { pid }", async () => {
      const res = makeRes();
      processService.create.mockReturnValue(4);

      await createProcess(makeReq({ body: { code: "x" } }), cast(res));

      expect(processService.waitForIdle).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ pid: 4 });
    });

    it.each([
      { body: {}, why: "missing code" },
      { body: { code: 123 }, why: "non-string code" },
      { body: { code: "x", ref: "" }, why: "empty ref" },
      { body: { code: "x", ref: "   " }, why: "whitespace-only ref" },
      { body: { code: "x", ref: 42 }, why: "non-string ref" },
      {
        body: { code: "x", options: { timeout: 0 } },
        why: "non-positive timeout",
      },
      {
        body: { code: "x", options: { timeout: -1 } },
        why: "negative timeout",
      },
      {
        body: { code: "x", options: { timeout: 1.5 } },
        why: "non-integer timeout",
      },
      {
        body: { code: "x", options: { timeout: "1000" } },
        why: "string timeout",
      },
    ])("rejects $why", async ({ body }) => {
      const res = makeRes();
      await expect(
        createProcess(makeReq({ body }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
    });

    it("rejects when body is not an object", async () => {
      const res = makeRes();
      await expect(
        createProcess(makeReq({ body: "not-an-object" }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });

  describe("getProcess", () => {
    it("returns the process for a valid pid", () => {
      const res = makeRes();
      processService.get.mockReturnValue({ pid: 12, state: "idle" });

      getProcess(makeReq({ params: { pid: "12" } }), cast(res));

      expect(processService.get).toHaveBeenCalledWith(12);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ pid: 12, state: "idle" });
    });

    it.each(["0", "-1", "abc", "", " "])("rejects pid=%s", (pid) => {
      const res = makeRes();
      expect(() => getProcess(makeReq({ params: { pid } }), cast(res))).toThrow(
        HttpError,
      );
    });
  });

  describe("getProcessOutput", () => {
    it("returns the output JSON", () => {
      const res = makeRes();
      processService.getOutput.mockReturnValue({ result: 42 });

      getProcessOutput(makeReq({ params: { pid: "5" } }), cast(res));

      expect(processService.getOutput).toHaveBeenCalledWith(5);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ result: 42 });
    });
  });

  describe("getProcessCode", () => {
    it("returns code as plain text", () => {
      const res = makeRes();
      processService.getCode.mockReturnValue("console.log(1)");

      getProcessCode(makeReq({ params: { pid: "5" } }), cast(res));

      expect(processService.getCode).toHaveBeenCalledWith(5);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.type).toHaveBeenCalledWith("text/plain");
      expect(res.send).toHaveBeenCalledWith("console.log(1)");
    });
  });

  describe("getProcessStdout", () => {
    it("returns stdout as plain text", () => {
      const res = makeRes();
      processService.getStdout.mockReturnValue("hello");

      getProcessStdout(makeReq({ params: { pid: "5" } }), cast(res));

      expect(res.type).toHaveBeenCalledWith("text/plain");
      expect(res.send).toHaveBeenCalledWith("hello");
    });
  });

  describe("getProcessStderr", () => {
    it("returns stderr as plain text", () => {
      const res = makeRes();
      processService.getStderr.mockReturnValue("err");

      getProcessStderr(makeReq({ params: { pid: "5" } }), cast(res));

      expect(res.type).toHaveBeenCalledWith("text/plain");
      expect(res.send).toHaveBeenCalledWith("err");
    });
  });

  describe("killProcess", () => {
    it("returns the process record from kill()", () => {
      const res = makeRes();
      processService.kill.mockReturnValue({ pid: 7, state: "terminating" });

      killProcess(makeReq({ params: { pid: "7" }, body: {} }), cast(res));

      expect(processService.kill).toHaveBeenCalledWith(7);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        pid: 7,
        state: "terminating",
      });
    });

    it.each([
      { body: undefined, why: "no body" },
      { body: {}, why: "empty object" },
      { body: "ignored", why: "string body" },
      { body: [1, 2], why: "array body" },
    ])("accepts $why and ignores it", ({ body }) => {
      const res = makeRes();
      processService.kill.mockReturnValue({ pid: 7, state: "terminating" });

      killProcess(makeReq({ params: { pid: "7" }, body }), cast(res));

      expect(processService.kill).toHaveBeenCalledWith(7);
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe("deleteProcess", () => {
    it("returns the deleted process record", () => {
      const res = makeRes();
      processService.delete.mockReturnValue({ pid: 7, state: "idle" });

      deleteProcess(makeReq({ params: { pid: "7" } }), cast(res));

      expect(processService.delete).toHaveBeenCalledWith(7);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ pid: 7, state: "idle" });
    });
  });

  describe("runProcess", () => {
    it("runs without force by default", async () => {
      const res = makeRes();
      processService.run.mockReturnValue({ pid: 7, state: "queued" });

      await runProcess(makeReq({ params: { pid: "7" }, body: {} }), cast(res));

      expect(processService.run).toHaveBeenCalledWith(7, false);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ pid: 7, state: "queued" });
    });

    it("passes force=true to the service", async () => {
      const res = makeRes();
      processService.run.mockReturnValue({ pid: 7, state: "queued" });

      await runProcess(
        makeReq({ params: { pid: "7" }, body: { force: true } }),
        cast(res),
      );

      expect(processService.run).toHaveBeenCalledWith(7, true);
    });

    it.each([
      { body: { force: "yes" }, why: "non-boolean force" },
    ])("rejects $why", async ({ body }) => {
      const res = makeRes();
      await expect(
        runProcess(makeReq({ params: { pid: "7" }, body }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
    });

    it("rejects when body is not an object", async () => {
      const res = makeRes();
      await expect(
        runProcess(makeReq({ params: { pid: "7" }, body: "nope" }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });
});
