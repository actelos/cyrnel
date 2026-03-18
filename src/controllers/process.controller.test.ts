import { beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "@/models/error";

const processService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  getOutput: vi.fn(),
  getStdout: vi.fn(),
  getStderr: vi.fn(),
  kill: vi.fn(),
  delete: vi.fn(),
  run: vi.fn(),
}));

vi.mock("@/services/process-dummy.service", () => ({ processService }));

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

describe("process.controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists processes with parsed filters", () => {
    const res = makeRes();
    const req: any = {
      query: { state: "queued", status: "null", ref: "  test " },
    };
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
    const req: any = { body: {} };

    expect(() => createProcess(req, res)).toThrowError(HttpError);
  });

  it("creates process with valid body", () => {
    const res = makeRes();
    const req: any = { body: { code: "code", ref: "ref" } };
    processService.create.mockReturnValue(42);

    createProcess(req, res);

    expect(processService.create).toHaveBeenCalledWith("code", "ref");
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ pid: 42 });
  });

  it("gets a process and validates pid", () => {
    const res = makeRes();
    const req: any = { params: { pid: "12" } };
    processService.get.mockReturnValue({ pid: 12 });

    getProcess(req, res);

    expect(processService.get).toHaveBeenCalledWith(12);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ pid: 12 });

    const badReq: any = { params: { pid: "0" } };
    expect(() => getProcess(badReq, res)).toThrowError(HttpError);
  });

  it("returns output and stdout/stderr payloads", () => {
    const res = makeRes();
    const req: any = { params: { pid: "9" } };

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

    expect(() => runProcess({ params: { pid: "1" } } as any, res)).toThrowError(
      HttpError,
    );
    expect(() =>
      killProcess({ params: { pid: "1" } } as any, res),
    ).toThrowError(HttpError);

    expect(() =>
      runProcess(
        { params: { pid: "2" }, body: { force: "yes" } } as any,
        res,
      ),
    ).toThrowError(HttpError);

    const runReq: any = { params: { pid: "3" }, body: { force: true } };
    processService.run.mockReturnValue({ pid: 3 });
    runProcess(runReq, res);
    expect(processService.run).toHaveBeenCalledWith(3, true);

    const killReq: any = { params: { pid: "3" }, body: {} };
    processService.kill.mockReturnValue({ pid: 3 });
    killProcess(killReq, res);
    expect(processService.kill).toHaveBeenCalledWith(3);
  });

  it("deletes a process", () => {
    const res = makeRes();
    const req: any = { params: { pid: "7" } };
    processService.delete.mockReturnValue({ pid: 7 });

    deleteProcess(req, res);

    expect(processService.delete).toHaveBeenCalledWith(7);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ pid: 7 });
  });

  it("validates query state/status/ref values", () => {
    const res = makeRes();

    expect(() =>
      listProcesses(
        { query: { state: "bad" } } as any,
        res,
      ),
    ).toThrowError(HttpError);

    expect(() =>
      listProcesses(
        { query: { status: "invalid" } } as any,
        res,
      ),
    ).toThrowError(HttpError);

    expect(() =>
      listProcesses(
        { query: { ref: "   " } } as any,
        res,
      ),
    ).toThrowError(HttpError);
  });
});
