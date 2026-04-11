import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listTools } from "@/controllers/tool.controller";

const manifestService = {
  listTools: vi.fn(),
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
    app: { locals: { manifestService } },
    params: {},
    ...overrides,
  }) as unknown as Request;

describe("tool.controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gets tools filtered by name query", async () => {
    const res = makeRes();
    const req = makeReq({ query: { name: "echo" } });
    manifestService.listTools.mockResolvedValue([
      {
        serviceName: "svc-1",
        name: "echo",
        inputSchema: {},
        outputSchema: {},
      },
      {
        serviceName: "svc-2",
        name: "echo",
        inputSchema: {},
        outputSchema: {},
      },
    ]);

    await listTools(req, res as unknown as Response);

    expect(manifestService.listTools).toHaveBeenCalledWith("echo");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      tools: [
        {
          serviceName: "svc-1",
          name: "echo",
          inputSchema: {},
          outputSchema: {},
        },
        {
          serviceName: "svc-2",
          name: "echo",
          inputSchema: {},
          outputSchema: {},
        },
      ],
    });
  });

  it("gets all tools when no name filter is provided", async () => {
    const res = makeRes();
    const req = makeReq({ query: {} });
    manifestService.listTools.mockResolvedValue([]);

    await listTools(req, res as unknown as Response);

    expect(manifestService.listTools).toHaveBeenCalledWith(undefined);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ tools: [] });
  });
});
