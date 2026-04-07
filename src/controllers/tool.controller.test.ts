import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listTools } from "@/controllers/tool.controller";

const manifestService = {
  listToolsByName: vi.fn(),
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

  it("gets tools filtered by name", async () => {
    const res = makeRes();
    const req = makeReq({ params: { toolName: "echo" } });
    manifestService.listToolsByName.mockResolvedValue([
      {
        serviceId: "svc-1",
        name: "echo",
        inputSchema: {},
        outputSchema: {},
      },
      {
        serviceId: "svc-2",
        name: "echo",
        inputSchema: {},
        outputSchema: {},
      },
    ]);

    await listTools(req, res as unknown as Response);

    expect(manifestService.listToolsByName).toHaveBeenCalledWith("echo");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      tools: [
        {
          serviceId: "svc-1",
          name: "echo",
          inputSchema: {},
          outputSchema: {},
        },
        {
          serviceId: "svc-2",
          name: "echo",
          inputSchema: {},
          outputSchema: {},
        },
      ],
    });
  });
});
