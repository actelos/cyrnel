import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "@/models/error.model";

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

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  type: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
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
  const res = {} as MockResponse;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.type = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
};

const makeReq = (overrides: Record<string, unknown> = {}) =>
  ({
    app: { locals: { processService } },
    query: {},
    params: {},
    body: {},
    ...overrides,
  }) as unknown as Request;

describe("process.controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists processes with parsed filters", () => {
    const res = makeRes();
    const req = makeReq({
      query: { state: "queued", status: "null", ref: "  test " },
    });
    processService.list.mockReturnValue([{ pid: 1 }]);

    listProcesses(req, res as unknown as Response);

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
    const req = makeReq({ body: {} });

    expect(() => createProcess(req, res as unknown as Response)).toThrow(
      HttpError,
    );
  });

  it("creates process with valid body", () => {
    const res = makeRes();
    const req = makeReq({
      body: { code: "code", ref: "ref" },
    });
    processService.create.mockReturnValue(42);

    createProcess(req, res as unknown as Response);

    expect(processService.create).toHaveBeenCalledWith("code", "ref");
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ pid: 42 });
  });

  it("accepts create payload without ref", () => {
    const res = makeRes();
    const req = makeReq({ body: { code: "code" } });
    processService.create.mockReturnValue(7);

    createProcess(req, res as unknown as Response);

    expect(processService.create).toHaveBeenCalledWith("code", undefined);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ pid: 7 });
  });

  it("gets a process and validates pid", () => {
    const res = makeRes();
    const req = makeReq({ params: { pid: "12" } });
    processService.get.mockReturnValue({ pid: 12 });

    getProcess(req, res as unknown as Response);

    expect(processService.get).toHaveBeenCalledWith(12);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ pid: 12 });

    const badReq = makeReq({ params: { pid: "0" } });
    expect(() => getProcess(badReq, res as unknown as Response)).toThrow(
      HttpError,
    );
  });

  it("returns output and stdout/stderr payloads", () => {
    const res = makeRes();
    const req = makeReq({ params: { pid: "9" } });

    processService.getOutput.mockReturnValue({ ok: true });
    getProcessOutput(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });

    processService.getStdout.mockReturnValue("out");
    getProcessStdout(req, res as unknown as Response);
    expect(res.type).toHaveBeenCalledWith("text/plain");
    expect(res.send).toHaveBeenCalledWith("out");

    processService.getStderr.mockReturnValue("err");
    getProcessStderr(req, res as unknown as Response);
    expect(res.type).toHaveBeenCalledWith("text/plain");
    expect(res.send).toHaveBeenCalledWith("err");
  });

  it("runs and kills with body validation", () => {
    const res = makeRes();

    expect(() =>
      runProcess(
        makeReq({ params: { pid: "1" }, body: undefined }),
        res as unknown as Response,
      ),
    ).toThrow(HttpError);
    expect(() =>
      killProcess(
        makeReq({ params: { pid: "1" }, body: undefined }),
        res as unknown as Response,
      ),
    ).toThrow(HttpError);

    expect(() =>
      runProcess(
        makeReq({ params: { pid: "2" }, body: { force: "yes" } }),
        res as unknown as Response,
      ),
    ).toThrow(HttpError);

    const runReq = makeReq({
      params: { pid: "3" },
      body: { force: true },
    });
    processService.run.mockReturnValue({ pid: 3 });
    runProcess(runReq, res as unknown as Response);
    expect(processService.run).toHaveBeenCalledWith(3, true);

    const killReq = makeReq({ params: { pid: "3" }, body: {} });
    processService.kill.mockReturnValue({ pid: 3 });
    killProcess(killReq, res as unknown as Response);
    expect(processService.kill).toHaveBeenCalledWith(3);
  });

  it("deletes a process", () => {
    const res = makeRes();
    const req = makeReq({ params: { pid: "7" } });
    processService.delete.mockReturnValue({ pid: 7 });

    deleteProcess(req, res as unknown as Response);

    expect(processService.delete).toHaveBeenCalledWith(7);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ pid: 7 });
  });

  it("validates query state/status/ref values", () => {
    const res = makeRes();

    expect(() =>
      listProcesses(
        makeReq({ query: { state: "bad" } }),
        res as unknown as Response,
      ),
    ).toThrow(HttpError);

    const invalidStatusCall = () =>
      listProcesses(
        makeReq({ query: { status: "invalid" } }),
        res as unknown as Response,
      );
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
      listProcesses(
        makeReq({ query: { ref: "   " } }),
        res as unknown as Response,
      ),
    ).toThrow(HttpError);
  });

  it("accepts timeout as a valid status filter", () => {
    const res = makeRes();
    const req = makeReq({
      query: { status: "timeout" },
    });
    processService.list.mockReturnValue([{ pid: 2, status: "timeout" }]);

    listProcesses(req, res as unknown as Response);

    expect(processService.list).toHaveBeenCalledWith({
      state: undefined,
      status: "timeout",
      ref: undefined,
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
