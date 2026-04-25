import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createService,
  deleteService,
  getService,
  getToolByName,
  listServices,
  listTools,
  setServiceEnabled,
  setToolEnabled,
  updateService,
} from "@/controllers/service.controller";

const manifestService = {
  listServices: vi.fn(),
  getService: vi.fn(),
  listTools: vi.fn(),
  getTool: vi.fn(),
  createService: vi.fn(),
  updateService: vi.fn(),
  setServiceEnabled: vi.fn(),
  setToolEnabled: vi.fn(),
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
      {
        name: "service-a",
        type: "foo",
        source: "https://registry.example.com/service-a.json",
        hash: "hash-a",
        enabled: true,
      },
      {
        name: "service-b",
        type: "foo",
        source: "https://registry.example.com/service-b.json",
        hash: "hash-b",
        enabled: false,
      },
    ]);

    await listServices(req, res as unknown as Response);

    expect(manifestService.listServices).toHaveBeenCalledWith(undefined, null);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      services: [
        {
          name: "service-a",
          type: "foo",
          source: "https://registry.example.com/service-a.json",
          hash: "hash-a",
          enabled: true,
        },
        {
          name: "service-b",
          type: "foo",
          source: "https://registry.example.com/service-b.json",
          hash: "hash-b",
          enabled: false,
        },
      ],
    });
  });

  it("lists services with parsed query", async () => {
    const res = makeRes();
    const req = makeReq({ query: { query: "  svc " } });
    manifestService.listServices.mockResolvedValue([
      {
        name: "svc-1",
        type: "foo",
        source: "https://registry.example.com/svc-1.json",
        hash: "hash-1",
        enabled: true,
      },
    ]);

    await listServices(req, res as unknown as Response);

    expect(manifestService.listServices).toHaveBeenCalledWith("svc", null);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      services: [
        {
          name: "svc-1",
          type: "foo",
          source: "https://registry.example.com/svc-1.json",
          hash: "hash-1",
          enabled: true,
        },
      ],
    });
  });

  it("lists services with enabled query filter", async () => {
    const res = makeRes();
    const req = makeReq({ query: { enabled: "false" } });
    manifestService.listServices.mockResolvedValue([
      {
        name: "svc-disabled",
        type: "foo",
        source: "https://registry.example.com/svc-disabled.json",
        hash: "hash-disabled",
        enabled: false,
      },
    ]);

    await listServices(req, res as unknown as Response);

    expect(manifestService.listServices).toHaveBeenCalledWith(undefined, false);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      services: [
        {
          name: "svc-disabled",
          type: "foo",
          source: "https://registry.example.com/svc-disabled.json",
          hash: "hash-disabled",
          enabled: false,
        },
      ],
    });
  });

  it("gets a single service", async () => {
    const res = makeRes();
    const req = makeReq({ params: { serviceName: "svc-1" } });
    manifestService.getService.mockResolvedValue({
      name: "svc-1",
      type: "foo",
      source: "https://registry.example.com/svc-1.json",
      hash: "hash-1",
      enabled: true,
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
      type: "foo",
      source: "https://registry.example.com/svc-1.json",
      hash: "hash-1",
      enabled: true,
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
        enabled: true,
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
    ]);

    await listTools(req, res as unknown as Response);

    expect(manifestService.listTools).toHaveBeenCalledWith(
      "svc-1",
      "echo",
      null,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      tools: [
        {
          name: "echo",
          enabled: true,
          inputSchema: { type: "object" },
          outputSchema: { type: "string" },
        },
      ],
    });
  });

  it("lists service tools with enabled query filter", async () => {
    const res = makeRes();
    const req = makeReq({
      params: { serviceName: "svc-1" },
      query: { enabled: "true" },
    });

    manifestService.listTools.mockResolvedValue([
      {
        name: "echo",
        enabled: true,
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
    ]);

    await listTools(req, res as unknown as Response);

    expect(manifestService.listTools).toHaveBeenCalledWith(
      "svc-1",
      undefined,
      true,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      tools: [
        {
          name: "echo",
          enabled: true,
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
        enabled: true,
        metadata: { route: "invoke/echo" },
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
      serviceMetadata: { serverUrl: "http://127.0.0.1:9999" },
      serviceEnabled: true,
    });

    await getToolByName(req, res as unknown as Response);

    expect(manifestService.getTool).toHaveBeenCalledWith("svc-1", "echo");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      name: "echo",
      enabled: true,
      metadata: { route: "invoke/echo" },
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
    });
  });

  it("creates a service", async () => {
    const res = makeRes();
    const req = makeReq({
      body: {
        type: "foo",
        source: {
          metadata: {
            file_url: "https://registry.example.com/definition.json",
          },
        },
      },
    });
    manifestService.createService.mockResolvedValue({
      name: "svc-1",
      type: "foo",
    });

    await createService(req, res as unknown as Response);

    expect(manifestService.createService).toHaveBeenCalledWith({
      type: "foo",
      source: "https://registry.example.com/definition.json",
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ name: "svc-1", type: "foo" });
  });

  it("updates a service without request body params", async () => {
    const res = makeRes();
    const req = makeReq({ params: { serviceName: "svc-1" } });
    manifestService.updateService.mockResolvedValue(true);

    await updateService(req, res as unknown as Response);

    expect(manifestService.updateService).toHaveBeenCalledWith("svc-1");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ name: "svc-1", updated: true });
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

  it("sets service enabled state", async () => {
    const res = makeRes();
    const req = makeReq({
      params: { serviceName: "svc-1" },
      body: {
        enabled: false,
      },
    });
    manifestService.setServiceEnabled.mockResolvedValue(undefined);

    await setServiceEnabled(req, res as unknown as Response);

    expect(manifestService.setServiceEnabled).toHaveBeenCalledWith(
      "svc-1",
      false,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ name: "svc-1", enabled: false });
  });

  it("sets tool enabled state", async () => {
    const res = makeRes();
    const req = makeReq({
      params: { serviceName: "svc-1", toolName: "echo" },
      body: {
        enabled: false,
      },
    });
    manifestService.setToolEnabled.mockResolvedValue(undefined);

    await setToolEnabled(req, res as unknown as Response);

    expect(manifestService.setToolEnabled).toHaveBeenCalledWith(
      "svc-1",
      "echo",
      false,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      name: "echo",
      serviceName: "svc-1",
      enabled: false,
    });
  });
});
