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
    it("throws if processService is missing from app.locals", async () => {
      const res = makeRes();
      const req = {
        app: { locals: {} },
        query: {},
        params: {},
        body: {},
      } as unknown as Request;

      await expect(listProcesses(req, cast(res))).rejects.toThrow(
        /ProcessService not configured/,
      );
    });
  });

  describe("listProcesses", () => {
    it("forwards an empty filter when no query params are supplied", async () => {
      const res = makeRes();
      processService.list.mockResolvedValue([]);

      await listProcesses(makeReq(), cast(res));

      expect(processService.list).toHaveBeenCalledWith({
        ref: undefined,
        state: undefined,
        exitState: undefined,
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ processes: [] });
    });

    it("parses state, status, and ref query params", async () => {
      const res = makeRes();
      processService.list.mockResolvedValue([{ id: 1 }]);

      await listProcesses(
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
      expect(res.json).toHaveBeenCalledWith({ processes: [{ id: 1 }] });
    });

    it("maps status='null' to exitState=null", async () => {
      const res = makeRes();
      processService.list.mockResolvedValue([]);

      await listProcesses(makeReq({ query: { status: "null" } }), cast(res));

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
    ])("accepts state %s", async (state) => {
      const res = makeRes();
      processService.list.mockResolvedValue([]);

      await listProcesses(makeReq({ query: { state } }), cast(res));

      expect(processService.list).toHaveBeenCalledWith(
        expect.objectContaining({ state }),
      );
    });

    it.each([
      "success",
      "failed",
      "timeout",
      "canceled",
    ])("accepts status %s", async (status) => {
      const res = makeRes();
      processService.list.mockResolvedValue([]);

      await listProcesses(makeReq({ query: { status } }), cast(res));

      expect(processService.list).toHaveBeenCalledWith(
        expect.objectContaining({ exitState: status }),
      );
    });

    it("rejects invalid state", async () => {
      const res = makeRes();
      await expect(
        listProcesses(makeReq({ query: { state: "bogus" } }), cast(res)),
      ).rejects.toThrow(HttpError);
    });

    it("rejects invalid status", async () => {
      const res = makeRes();
      await expect(
        listProcesses(makeReq({ query: { status: "bogus" } }), cast(res)),
      ).rejects.toThrow(HttpError);
    });

    it("rejects an empty ref string after trim", async () => {
      const res = makeRes();
      await expect(
        listProcesses(makeReq({ query: { ref: "   " } }), cast(res)),
      ).rejects.toThrow(HttpError);
    });
  });

  describe("createProcess", () => {
    it("creates a process from a minimal body", async () => {
      const res = makeRes();
      processService.create.mockResolvedValue({ id: 42 });

      await createProcess(
        makeReq({ body: { code: "console.log(1)" } }),
        cast(res),
      );

      expect(processService.create).toHaveBeenCalledWith({
        ref: undefined,
        code: "console.log(1)",
        options: { timeoutMs: undefined },
        autorun: true,
      });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ id: 42 });
      expect(processService.waitForIdle).not.toHaveBeenCalled();
    });

    it("includes ref and timeout from the body", async () => {
      const res = makeRes();
      processService.create.mockResolvedValue({ id: 7 });

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
        autorun: true,
      });
    });

    it("allows null timeout", async () => {
      const res = makeRes();
      processService.create.mockResolvedValue({ id: 9 });

      await createProcess(
        makeReq({ body: { code: "x", options: { timeout: null } } }),
        cast(res),
      );

      expect(processService.create).toHaveBeenCalledWith({
        ref: undefined,
        code: "x",
        options: { timeoutMs: null },
        autorun: true,
      });
    });

    it("defaults autorun to true", async () => {
      const res = makeRes();
      processService.create.mockResolvedValue({ id: 5 });

      await createProcess(makeReq({ body: { code: "x" } }), cast(res));

      expect(processService.create).toHaveBeenCalledWith(
        expect.objectContaining({ autorun: true }),
      );
    });

    it("passes autorun=false from the body", async () => {
      const res = makeRes();
      processService.create.mockResolvedValue({ id: 6 });

      await createProcess(
        makeReq({ body: { code: "x", autorun: false } }),
        cast(res),
      );

      expect(processService.create).toHaveBeenCalledWith(
        expect.objectContaining({ autorun: false }),
      );
    });

    it("returns { id }", async () => {
      const res = makeRes();
      processService.create.mockResolvedValue({ id: 4 });

      await createProcess(makeReq({ body: { code: "x" } }), cast(res));

      expect(processService.waitForIdle).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ id: 4 });
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
      {
        body: { code: "x".repeat(100 * 1024 + 1) },
        why: "oversized code",
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
    it("returns the process for a valid id", async () => {
      const res = makeRes();
      processService.get.mockResolvedValue({ id: 12, state: "idle" });

      await getProcess(makeReq({ params: { id: "12" } }), cast(res));

      expect(processService.get).toHaveBeenCalledWith(12);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ id: 12, state: "idle" });
    });

    it.each(["0", "-1", "abc", "", " "])("rejects id=%s", async (id) => {
      const res = makeRes();
      await expect(
        getProcess(makeReq({ params: { id } }), cast(res)),
      ).rejects.toThrow(HttpError);
    });
  });

  describe("getProcessOutput", () => {
    it("returns the output JSON", async () => {
      const res = makeRes();
      processService.getOutput.mockResolvedValue({ result: 42 });

      await getProcessOutput(makeReq({ params: { id: "5" } }), cast(res));

      expect(processService.getOutput).toHaveBeenCalledWith(5);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ result: 42 });
    });
  });

  describe("getProcessCode", () => {
    it("returns code as plain text", async () => {
      const res = makeRes();
      processService.getCode.mockResolvedValue("console.log(1)");

      await getProcessCode(makeReq({ params: { id: "5" } }), cast(res));

      expect(processService.getCode).toHaveBeenCalledWith(5);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.type).toHaveBeenCalledWith("text/plain");
      expect(res.send).toHaveBeenCalledWith("console.log(1)");
    });
  });

  describe("getProcessStdout", () => {
    it("returns stdout as plain text", async () => {
      const res = makeRes();
      processService.getStdout.mockResolvedValue("hello");

      await getProcessStdout(makeReq({ params: { id: "5" } }), cast(res));

      expect(res.type).toHaveBeenCalledWith("text/plain");
      expect(res.send).toHaveBeenCalledWith("hello");
    });
  });

  describe("getProcessStderr", () => {
    it("returns stderr as plain text", async () => {
      const res = makeRes();
      processService.getStderr.mockResolvedValue("err");

      await getProcessStderr(makeReq({ params: { id: "5" } }), cast(res));

      expect(res.type).toHaveBeenCalledWith("text/plain");
      expect(res.send).toHaveBeenCalledWith("err");
    });
  });

  describe("killProcess", () => {
    it("returns the process record from kill()", async () => {
      const res = makeRes();
      processService.kill.mockResolvedValue({ id: 7, state: "terminating" });

      await killProcess(makeReq({ params: { id: "7" }, body: {} }), cast(res));

      expect(processService.kill).toHaveBeenCalledWith(7);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        id: 7,
        state: "terminating",
      });
    });
  });

  describe("deleteProcess", () => {
    it("returns the deleted process record", async () => {
      const res = makeRes();
      processService.delete.mockResolvedValue({ id: 7, state: "idle" });

      await deleteProcess(makeReq({ params: { id: "7" } }), cast(res));

      expect(processService.delete).toHaveBeenCalledWith(7);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ id: 7, state: "idle" });
    });
  });

  describe("runProcess", () => {
    it("runs without force by default", async () => {
      const res = makeRes();
      processService.run.mockResolvedValue({ id: 7, state: "queued" });

      await runProcess(makeReq({ params: { id: "7" }, body: {} }), cast(res));

      expect(processService.run).toHaveBeenCalledWith(7, false);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ id: 7, state: "queued" });
    });

    it("passes force=true to the service", async () => {
      const res = makeRes();
      processService.run.mockResolvedValue({ id: 7, state: "queued" });

      await runProcess(
        makeReq({ params: { id: "7" }, body: { force: true } }),
        cast(res),
      );

      expect(processService.run).toHaveBeenCalledWith(7, true);
    });

    it.each([
      { body: { force: "yes" }, why: "non-boolean force" },
    ])("rejects $why", async ({ body }) => {
      const res = makeRes();
      await expect(
        runProcess(makeReq({ params: { id: "7" }, body }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
    });

    it("rejects when body is not an object", async () => {
      const res = makeRes();
      await expect(
        runProcess(makeReq({ params: { id: "7" }, body: "nope" }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });
});
