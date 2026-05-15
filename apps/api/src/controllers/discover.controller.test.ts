import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  discoverServices,
  discoverTools,
} from "@/controllers/discover.controller";

const manifestService = {
  discoverTools: vi.fn(),
  discoverServices: vi.fn(),
};

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

const makeRes = () => {
  const res = {} as MockResponse;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
};

const makeReq = (overrides: Partial<Request> & { body?: unknown } = {}) => {
  const app = {
    locals: {
      manifestService,
    },
  } as unknown as Request["app"];

  return {
    app,
    params: {},
    query: {},
    body: {},
    ...overrides,
  } as unknown as Request;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("discover.controller", () => {
  it("discovers tools using body payload", async () => {
    const res = makeRes();
    const req = makeReq({
      body: { query: "  github issues ", limit: 5, enabled: null },
    });

    manifestService.discoverTools.mockResolvedValueOnce([
      {
        serviceName: "github",
        name: "listIssues",
        description: "List issues",
        enabled: false,
      },
    ]);

    await discoverTools(req, res as unknown as Response);

    expect(manifestService.discoverTools).toHaveBeenCalledWith(
      "github issues",
      5,
      null,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      tools: [
        {
          serviceName: "github",
          name: "listIssues",
          description: "List issues",
          enabled: false,
        },
      ],
    });
  });

  it("discovers services using body payload", async () => {
    const res = makeRes();
    const req = makeReq({
      body: { query: " github ", limit: 3, enabled: false },
    });

    manifestService.discoverServices.mockResolvedValueOnce([
      {
        name: "github",
        type: "registry",
        source: "https://registry.example.com/github.json",
        description: "GitHub",
        hash: "hash-github",
        enabled: false,
      },
    ]);

    await discoverServices(req, res as unknown as Response);

    expect(manifestService.discoverServices).toHaveBeenCalledWith(
      "github",
      3,
      false,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      services: [
        {
          name: "github",
          type: "registry",
          source: "https://registry.example.com/github.json",
          description: "GitHub",
          hash: "hash-github",
          enabled: false,
        },
      ],
    });
  });

  it("discovers with empty body defaults", async () => {
    const res = makeRes();
    const req = makeReq({ body: {} });

    manifestService.discoverTools.mockResolvedValueOnce([]);

    await discoverTools(req, res as unknown as Response);

    expect(manifestService.discoverTools).toHaveBeenCalledWith("", undefined);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ tools: [] });
  });
});
