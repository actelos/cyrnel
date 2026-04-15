import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createService,
  deleteService,
  getService,
  getToolByName,
  listServices,
  listTools,
  updateService,
} from "@/controllers/service.controller";

const manifestService = {
  listServices: vi.fn(),
  getService: vi.fn(),
  listTools: vi.fn(),
  getTool: vi.fn(),
  createService: vi.fn(),
  updateService: vi.fn(),
  deleteService: vi.fn(),
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

const makeReq = (overrides: Record<string, unknown> = {}) =>
  ({
    app: { locals: { manifestService } },
    params: {},
    ...overrides,
  }) as unknown as Request;

describe("service.controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists services", async () => {
    const res = makeRes();
    const req = makeReq();
    manifestService.listServices.mockResolvedValue([
      { name: "service-a", hash: "hash-a" },
      { name: "service-b", hash: "hash-b" },
    ]);

    await listServices(req, res as unknown as Response);

    expect(manifestService.listServices).toHaveBeenCalledWith(undefined);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      services: [
        { name: "service-a", hash: "hash-a" },
        { name: "service-b", hash: "hash-b" },
      ],
    });
  });

  it("lists services with parsed query", async () => {
    const res = makeRes();
    const req = makeReq({ query: { query: "  svc " } });
    manifestService.listServices.mockResolvedValue([
      { name: "svc-1", hash: "hash-1" },
    ]);

    await listServices(req, res as unknown as Response);

    expect(manifestService.listServices).toHaveBeenCalledWith("svc");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      services: [{ name: "svc-1", hash: "hash-1" }],
    });
  });

  it("gets a single service", async () => {
    const res = makeRes();
    const req = makeReq({ params: { serviceName: "svc-1" } });
    manifestService.getService.mockResolvedValue({
      name: "svc-1",
      hash: "hash-1",
      metadata: { serverUrl: "http://127.0.0.1:9999" },
      tools: [
        {
          name: "echo",
          metadata: {},
          inputSchema: { type: "object" },
          outputSchema: { type: "string" },
        },
      ],
    });

    await getService(req, res as unknown as Response);

    expect(manifestService.getService).toHaveBeenCalledWith("svc-1");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      name: "svc-1",
      hash: "hash-1",
      metadata: { serverUrl: "http://127.0.0.1:9999" },
    });
  });

  it("lists service tools", async () => {
    const res = makeRes();
    const req = makeReq({
      params: { serviceName: "svc-1" },
      query: { query: "  echo " },
    });

    manifestService.listTools.mockResolvedValue([
      {
        name: "echo",
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
    ]);

    await listTools(req, res as unknown as Response);

    expect(manifestService.listTools).toHaveBeenCalledWith("svc-1", "echo");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      tools: [
        {
          name: "echo",
          inputSchema: { type: "object" },
          outputSchema: { type: "string" },
        },
      ],
    });
  });

  it("gets a single tool by name", async () => {
    const res = makeRes();
    const req = makeReq({
      params: { serviceName: "svc-1", toolName: "echo" },
    });

    manifestService.getTool.mockResolvedValue({
      tool: {
        name: "echo",
        metadata: { route: "invoke/echo" },
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
      serviceMetadata: { serverUrl: "http://127.0.0.1:9999" },
    });

    await getToolByName(req, res as unknown as Response);

    expect(manifestService.getTool).toHaveBeenCalledWith("svc-1", "echo");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      name: "echo",
      metadata: { route: "invoke/echo" },
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
    });
  });

  it("creates a service", async () => {
    const res = makeRes();
    const req = makeReq({
      params: { serviceName: "svc-1" },
      body: {
        definitionId: "def-123",
      },
    });

    await createService(req, res as unknown as Response);

    expect(manifestService.createService).toHaveBeenCalledWith(
      "svc-1",
      "def-123",
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ name: "svc-1" });
  });

  it("deletes a service", async () => {
    const res = makeRes();
    const req = makeReq({ params: { serviceName: "svc-1" } });
    manifestService.deleteService.mockResolvedValue(undefined);

    await deleteService(req, res as unknown as Response);

    expect(manifestService.deleteService).toHaveBeenCalledWith("svc-1");
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalledWith();
  });

  it("updates a service when definition hash changed", async () => {
    const res = makeRes();
    const req = makeReq({
      params: { serviceName: "svc-1" },
      body: {
        definitionId: "def-123",
      },
    });
    manifestService.updateService.mockResolvedValue(true);

    await updateService(req, res as unknown as Response);

    expect(manifestService.updateService).toHaveBeenCalledWith(
      "svc-1",
      "def-123",
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ name: "svc-1", updated: true });
  });
});
