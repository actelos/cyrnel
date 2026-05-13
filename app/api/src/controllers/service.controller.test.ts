import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createService,
  deleteService,
  getService,
  getServiceConfiguration,
  getServiceConfigurationSchema,
  getServiceSecretsSchema,
  getServiceTool,
  listServices,
  listServiceTools,
  patchServiceConfiguration,
  patchServiceSecrets,
  setServiceEnabled,
  setServiceToolEnabled,
  updateService,
} from "@/controllers/service.controller";

const manifestService = {
  listServices: vi.fn(),
  getService: vi.fn(),
  getServiceConfig: vi.fn(),
  getServiceConfigSchema: vi.fn(),
  getServiceSecretsSchema: vi.fn(),
  patchServiceConfig: vi.fn(),
  patchServiceSecrets: vi.fn(),
  createService: vi.fn(),
  updateService: vi.fn(),
  setServiceEnabled: vi.fn(),
  deleteService: vi.fn(),
  listTools: vi.fn(),
  getToolWithServiceInfo: vi.fn(),
  setToolEnabled: vi.fn(),
};

const environmentPoolService = {
  requestRestage: vi.fn(),
};

const adapterPoolService = {
  requestRestage: vi.fn(),
  updateServiceConfig: vi.fn(),
  updateServiceSecrets: vi.fn(),
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
    app: {
      locals: { manifestService, environmentPoolService, adapterPoolService },
    },
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
      description: "Service description",
      hash: "hash-1",
      enabled: true,
      configSchema: { type: "object" },
      secretsSchema: { type: "object" },
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
      description: "Service description",
      hash: "hash-1",
      enabled: true,
      configSchema: { type: "object" },
      secretsSchema: { type: "object" },
    });
  });

  it("gets service configuration", async () => {
    const res = makeRes();
    const req = makeReq({ params: { serviceName: "svc-1" } });

    manifestService.getServiceConfig.mockResolvedValue({});

    await getServiceConfiguration(req, res as unknown as Response);

    expect(manifestService.getServiceConfig).toHaveBeenCalledWith("svc-1");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ config: {} });
  });

  it("gets service configuration schema", async () => {
    const res = makeRes();
    const req = makeReq({ params: { serviceName: "svc-1" } });

    manifestService.getServiceConfigSchema.mockResolvedValue({
      type: "object",
    });

    await getServiceConfigurationSchema(req, res as unknown as Response);

    expect(manifestService.getServiceConfigSchema).toHaveBeenCalledWith(
      "svc-1",
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ configSchema: { type: "object" } });
  });

  it("gets service secrets schema", async () => {
    const res = makeRes();
    const req = makeReq({ params: { serviceName: "svc-1" } });

    manifestService.getServiceSecretsSchema.mockResolvedValue({
      type: "object",
    });

    await getServiceSecretsSchema(req, res as unknown as Response);

    expect(manifestService.getServiceSecretsSchema).toHaveBeenCalledWith(
      "svc-1",
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      secretsSchema: { type: "object" },
    });
  });

  it("patches service configuration and updates adapters", async () => {
    const res = makeRes();
    const req = makeReq({
      params: { serviceName: "svc-1" },
      body: [{ op: "add", path: "/enabled", value: true }],
    });

    manifestService.patchServiceConfig.mockResolvedValue({ enabled: true });

    await patchServiceConfiguration(req, res as unknown as Response);

    expect(manifestService.patchServiceConfig).toHaveBeenCalledWith("svc-1", [
      { op: "add", path: "/enabled", value: true },
    ]);
    expect(adapterPoolService.updateServiceConfig).toHaveBeenCalledWith(
      "svc-1",
      {
        enabled: true,
      },
    );
    expect(adapterPoolService.requestRestage).toHaveBeenCalled();
    expect(environmentPoolService.requestRestage).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ config: { enabled: true } });
  });

  it("patches service secrets and restages adapters", async () => {
    const res = makeRes();
    const req = makeReq({
      params: { serviceName: "svc-1" },
      body: [{ op: "add", path: "/token", value: "secret" }],
    });

    manifestService.patchServiceSecrets.mockResolvedValue({
      token: "secret",
    });

    await patchServiceSecrets(req, res as unknown as Response);

    expect(manifestService.patchServiceSecrets).toHaveBeenCalledWith("svc-1", [
      { op: "add", path: "/token", value: "secret" },
    ]);
    expect(adapterPoolService.updateServiceSecrets).toHaveBeenCalledWith(
      "svc-1",
      {
        token: "secret",
      },
    );
    expect(adapterPoolService.requestRestage).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ updated: true });
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
    expect(environmentPoolService.requestRestage).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ name: "svc-1", type: "foo" });
  });

  it("updates a service without request body params", async () => {
    const res = makeRes();
    const req = makeReq({ params: { serviceName: "svc-1" } });
    manifestService.updateService.mockResolvedValue(true);

    await updateService(req, res as unknown as Response);

    expect(manifestService.updateService).toHaveBeenCalledWith("svc-1");
    expect(environmentPoolService.requestRestage).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ name: "svc-1", updated: true });
  });

  it("does not request restage when update reports no change", async () => {
    const res = makeRes();
    const req = makeReq({ params: { serviceName: "svc-1" } });
    manifestService.updateService.mockResolvedValue(false);

    await updateService(req, res as unknown as Response);

    expect(environmentPoolService.requestRestage).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ name: "svc-1", updated: false });
  });

  it("deletes a service", async () => {
    const res = makeRes();
    const req = makeReq({ params: { serviceName: "svc-1" } });
    manifestService.deleteService.mockResolvedValue(undefined);

    await deleteService(req, res as unknown as Response);

    expect(manifestService.deleteService).toHaveBeenCalledWith("svc-1");
    expect(environmentPoolService.requestRestage).toHaveBeenCalledTimes(1);
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
    expect(environmentPoolService.requestRestage).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ name: "svc-1", enabled: false });
  });

  it("lists tools within a service using URL params", async () => {
    const res = makeRes();
    const req = makeReq({
      params: { serviceName: "svc-1" },
      query: { query: "  echo ", enabled: "null" },
    });

    manifestService.listTools.mockResolvedValueOnce([
      {
        name: "echo",
        description: "Echo",
        enabled: true,
      },
    ]);

    await listServiceTools(req, res as unknown as Response);

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
          description: "Echo",
          enabled: true,
        },
      ],
    });
  });

  it("gets a tool by name within a service using URL params", async () => {
    const res = makeRes();
    const req = makeReq({
      params: { serviceName: "svc-1", toolName: "echo" },
    });

    manifestService.getToolWithServiceInfo.mockResolvedValueOnce({
      serviceName: "svc-1",
      serviceDescription: "Service 1",
      tool: {
        name: "echo",
        description: "Echo",
        enabled: true,
        metadata: { route: "invoke/echo" },
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
      serviceMetadata: { serverUrl: "http://127.0.0.1:9999" },
      serviceEnabled: true,
    });

    await getServiceTool(req, res as unknown as Response);

    expect(manifestService.getToolWithServiceInfo).toHaveBeenCalledWith(
      "svc-1",
      "echo",
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      name: "echo",
      description: "Echo",
      enabled: true,
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
    });
  });

  it("sets a tool enabled state using URL params", async () => {
    const res = makeRes();
    const req = makeReq({
      params: { serviceName: "svc-1", toolName: "echo" },
      body: { enabled: false },
    });

    await setServiceToolEnabled(req, res as unknown as Response);

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
