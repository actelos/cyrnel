import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteLogs, listLogs } from "@/controllers/log.controller";
import { HttpError } from "@/models/error.model";

const logService = {
  list: vi.fn(),
  count: vi.fn(),
  deleteByMessageQuery: vi.fn(),
};

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
};

const makeRes = () => {
  const res = {} as MockResponse;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

const makeReq = (overrides: Record<string, unknown> = {}) =>
  ({
    app: { locals: { logService } },
    query: {},
    ...overrides,
  }) as unknown as Request;

describe("log.controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists logs using parsed filters", async () => {
    const res = makeRes();
    const req = makeReq({
      query: {
        query: "  timeout ",
        severity: "ERROR",
        from: "1700000000000",
        to: "1700000000500",
        limit: "50",
        offset: "10",
      },
    });

    logService.list.mockResolvedValue([{ id: 1, message: "timeout" }]);
    logService.count.mockResolvedValue(1);

    await listLogs(req, res as unknown as Response);

    expect(logService.list).toHaveBeenCalledWith({
      query: "timeout",
      severity: "error",
      from: 1700000000000,
      to: 1700000000500,
      limit: 50,
      offset: 10,
    });
    expect(logService.count).toHaveBeenCalledWith({
      query: "timeout",
      severity: "error",
      from: 1700000000000,
      to: 1700000000500,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      logs: [{ id: 1, message: "timeout" }],
      count: 1,
      limit: 50,
      offset: 10,
    });
  });

  it("uses default pagination values", async () => {
    const res = makeRes();
    const req = makeReq();

    logService.list.mockResolvedValue([]);
    logService.count.mockResolvedValue(0);

    await listLogs(req, res as unknown as Response);

    expect(logService.list).toHaveBeenCalledWith({
      query: undefined,
      severity: undefined,
      from: undefined,
      to: undefined,
      limit: 100,
      offset: 0,
    });
  });

  it("treats blank query as undefined for list", async () => {
    const res = makeRes();
    const req = makeReq({ query: { query: "   " } });

    logService.list.mockResolvedValue([]);
    logService.count.mockResolvedValue(0);

    await listLogs(req, res as unknown as Response);

    expect(logService.list).toHaveBeenCalledWith({
      query: undefined,
      severity: undefined,
      from: undefined,
      to: undefined,
      limit: 100,
      offset: 0,
    });
  });

  it("rejects invalid severity", async () => {
    const res = makeRes();
    const req = makeReq({ query: { severity: "critical" } });

    await expect(
      listLogs(req, res as unknown as Response),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("rejects invalid limit and offset", async () => {
    const res = makeRes();

    await expect(
      listLogs(
        makeReq({ query: { limit: "1001" } }),
        res as unknown as Response,
      ),
    ).rejects.toBeInstanceOf(HttpError);

    await expect(
      listLogs(
        makeReq({ query: { offset: "-1" } }),
        res as unknown as Response,
      ),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("deletes logs by query", async () => {
    const res = makeRes();
    const req = makeReq({ query: { query: "  timeout " } });
    logService.deleteByMessageQuery.mockResolvedValue(3);

    await deleteLogs(req, res as unknown as Response);

    expect(logService.deleteByMessageQuery).toHaveBeenCalledWith("timeout");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ query: "timeout", deleted: 3 });
  });

  it("requires query for deletion", async () => {
    const res = makeRes();
    const req = makeReq({ query: {} });

    await expect(
      deleteLogs(req, res as unknown as Response),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("rejects empty query for deletion", async () => {
    const res = makeRes();
    const req = makeReq({ query: { query: "   " } });

    await expect(
      deleteLogs(req, res as unknown as Response),
    ).rejects.toBeInstanceOf(HttpError);
  });
});
