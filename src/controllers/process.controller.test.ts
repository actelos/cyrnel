import { beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "@/models/error";

const processService = {
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  getOutput: vi.fn(),
  getStdout: vi.fn(),
  getStderr: vi.fn(),
  kill: vi.fn(),
  delete: vi.fn(),
  run: vi.fn(),
};

import {
  createProcess,
  deleteProcess,
  getProcess,
  getProcessOutput,
  getProcessStderr,
  getProcessStdout,
  killProcess,
  listProcesses,
  runProcess,
} from "@/controllers/process.controller";

const makeRes = () => {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.type = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
};

const makeReq = (overrides: Record<string, unknown> = {}) => ({
  app: { locals: { processService } },
  query: {},
  params: {},
  body: {},
  ...overrides,
});

describe("process.controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists processes with parsed filters", () => {
    const res = makeRes();
    const req: any = makeReq({
      query: { state: "queued", status: "null", ref: "  test " },
    });
    processService.list.mockReturnValue([{ pid: 1 }]);

    listProcesses(req, res);

    expect(processService.list).toHaveBeenCalledWith({
      state: "queued",
      status: null,
      ref: "test",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ processes: [{ pid: 1 }] });
  });

  it("rejects invalid create payloads", () => {
    const res = makeRes();
    const req: any = makeReq({ body: {} });

    expect(() => createProcess(req, res)).toThrow(HttpError);
  });

  it("creates process with valid body", () => {
    const res = makeRes();
    const req: any = makeReq({
      body: { code: "code", environment: "node", ref: "ref" },
    });
    processService.create.mockReturnValue(42);

    createProcess(req, res);

    expect(processService.create).toHaveBeenCalledWith("code", "node", "ref");
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ pid: 42 });
  });

  it("rejects invalid environment in create payload", () => {
    const res = makeRes();

    let err: unknown;

    try {
      createProcess(makeReq({ body: { code: "code" } }) as any, res);
    } catch (caught) {
      err = caught;
    }

    expect(err).toBeInstanceOf(HttpError);
    expect((err as Error).message).toBe("Missing required field: environment");

    err = undefined;

    try {
      createProcess(
        makeReq({ body: { code: "code", environment: 123 } }) as any,
        res,
      );
    } catch (caught) {
      err = caught;
    }

    expect(err).toBeInstanceOf(HttpError);
    expect((err as Error).message).toBe(
      "Field 'environment' must be a string.",
    );

    err = undefined;

    try {
      createProcess(
        makeReq({ body: { code: "code", environment: "   " } }) as any,
        res,
      );
    } catch (caught) {
      err = caught;
    }

    expect(err).toBeInstanceOf(HttpError);
    expect((err as Error).message).toBe(
      "Field 'environment' must not be empty.",
    );
  });

  it("gets a process and validates pid", () => {
    const res = makeRes();
    const req: any = makeReq({ params: { pid: "12" } });
    processService.get.mockReturnValue({ pid: 12 });

    getProcess(req, res);

    expect(processService.get).toHaveBeenCalledWith(12);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ pid: 12 });

    const badReq: any = makeReq({ params: { pid: "0" } });
    expect(() => getProcess(badReq, res)).toThrow(HttpError);
  });

  it("returns output and stdout/stderr payloads", () => {
    const res = makeRes();
    const req: any = makeReq({ params: { pid: "9" } });

    processService.getOutput.mockReturnValue({ ok: true });
    getProcessOutput(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ output: { ok: true } });

    processService.getStdout.mockReturnValue("out");
    getProcessStdout(req, res);
    expect(res.type).toHaveBeenCalledWith("text/plain");
    expect(res.send).toHaveBeenCalledWith("out");

    processService.getStderr.mockReturnValue("err");
    getProcessStderr(req, res);
    expect(res.type).toHaveBeenCalledWith("text/plain");
    expect(res.send).toHaveBeenCalledWith("err");
  });

  it("runs and kills with body validation", () => {
    const res = makeRes();

    expect(() =>
      runProcess(
        makeReq({ params: { pid: "1" }, body: undefined }) as any,
        res,
      ),
    ).toThrow(HttpError);
    expect(() =>
      killProcess(
        makeReq({ params: { pid: "1" }, body: undefined }) as any,
        res,
      ),
    ).toThrow(HttpError);

    expect(() =>
      runProcess(
        makeReq({ params: { pid: "2" }, body: { force: "yes" } }) as any,
        res,
      ),
    ).toThrow(HttpError);

    const runReq: any = makeReq({
      params: { pid: "3" },
      body: { force: true },
    });
    processService.run.mockReturnValue({ pid: 3 });
    runProcess(runReq, res);
    expect(processService.run).toHaveBeenCalledWith(3, true);

    const killReq: any = makeReq({ params: { pid: "3" }, body: {} });
    processService.kill.mockReturnValue({ pid: 3 });
    killProcess(killReq, res);
    expect(processService.kill).toHaveBeenCalledWith(3);
  });

  it("deletes a process", () => {
    const res = makeRes();
    const req: any = makeReq({ params: { pid: "7" } });
    processService.delete.mockReturnValue({ pid: 7 });

    deleteProcess(req, res);

    expect(processService.delete).toHaveBeenCalledWith(7);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ pid: 7 });
  });

  it("validates query state/status/ref values", () => {
    const res = makeRes();

    expect(() =>
      listProcesses(makeReq({ query: { state: "bad" } }) as any, res),
    ).toThrow(HttpError);

    const invalidStatusCall = () =>
      listProcesses(makeReq({ query: { status: "invalid" } }) as any, res);
    let err: unknown;

    try {
      invalidStatusCall();
    } catch (caught) {
      err = caught;
    }

    expect(err).toBeInstanceOf(HttpError);
    expect((err as Error).message).toMatch(
      /success, failed, timeout, canceled, null/,
    );

    expect(() =>
      listProcesses(makeReq({ query: { ref: "   " } }) as any, res),
    ).toThrow(HttpError);
  });

  it("accepts timeout as a valid status filter", () => {
    const res = makeRes();
    const req: any = makeReq({
      query: { status: "timeout" },
    });
    processService.list.mockReturnValue([{ pid: 2, status: "timeout" }]);

    listProcesses(req, res);

    expect(processService.list).toHaveBeenCalledWith({
      state: undefined,
      status: "timeout",
      ref: undefined,
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
