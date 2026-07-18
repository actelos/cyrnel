import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createServiceDirect,
  deleteService,
  getService,
  getServiceConfiguration,
  getServiceConfigurationSchema,
  getServiceSecrets,
  getServiceSecretsSchema,
  installServiceRegistry,
  listServices,
  patchService,
  patchServiceConfiguration,
  patchServiceSecrets,
  setServiceEnabled,
  updateService,
} from "@/controllers/service.controller";
import { HttpError } from "@/models/error.model";

const servicesService = {
  listServices: vi.fn(),
  getService: vi.fn(),
  getServiceConfig: vi.fn(),
  getServiceConfigSchema: vi.fn(),
  getServiceSecretsPresence: vi.fn(),
  getServiceSecretsSchema: vi.fn(),
  patchServiceConfig: vi.fn(),
  patchServiceSecrets: vi.fn(),
  createServiceDirect: vi.fn(),
  createServiceFromRegistry: vi.fn(),
  patchService: vi.fn(),
  updateService: vi.fn(),
  setServiceEnabled: vi.fn(),
  deleteService: vi.fn(),
};

interface MockResponse {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  type: ReturnType<typeof vi.fn>;
}

const makeRes = (): MockResponse => {
  const res = {} as MockResponse;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.type = vi.fn().mockReturnValue(res);
  return res;
};

const makeReq = (overrides: Record<string, unknown> = {}): Request =>
  ({
    app: { locals: { servicesService } },
    params: {},
    query: {},
    body: {},
    ...overrides,
  }) as unknown as Request;

const cast = (res: MockResponse) => res as unknown as Response;

describe("service.controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("locals wiring", () => {
    it("throws if servicesService is missing from app.locals", async () => {
      const res = makeRes();
      const req = {
        app: { locals: {} },
        params: {},
        query: {},
        body: {},
      } as unknown as Request;

      await expect(listServices(req, cast(res))).rejects.toThrow(
        /ServicesService not configured/,
      );
    });
  });

  describe("listServices", () => {
    it("calls listServices with undefined filters by default", async () => {
      const res = makeRes();
      servicesService.listServices.mockResolvedValue([]);

      await listServices(makeReq(), cast(res));

      expect(servicesService.listServices).toHaveBeenCalledWith({
        query: undefined,
        enabled: undefined,
        stale: undefined,
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ services: [] });
    });

    it("trims the query param", async () => {
      const res = makeRes();
      servicesService.listServices.mockResolvedValue([{ id: "svc" }]);

      await listServices(makeReq({ query: { query: "  svc " } }), cast(res));

      expect(servicesService.listServices).toHaveBeenCalledWith({
        query: "svc",
        enabled: undefined,
        stale: undefined,
      });
    });

    it("treats an all-whitespace query as undefined", async () => {
      const res = makeRes();
      servicesService.listServices.mockResolvedValue([]);

      await listServices(makeReq({ query: { query: "   " } }), cast(res));

      expect(servicesService.listServices).toHaveBeenCalledWith({
        query: undefined,
        enabled: undefined,
        stale: undefined,
      });
    });

    it.each([
      ["true", true],
      ["false", false],
      ["TRUE", true],
      ["  False  ", false],
    ])("coerces enabled=%s -> %s", async (raw, expected) => {
      const res = makeRes();
      servicesService.listServices.mockResolvedValue([]);

      await listServices(makeReq({ query: { enabled: raw } }), cast(res));

      expect(servicesService.listServices).toHaveBeenCalledWith({
        query: undefined,
        enabled: expected,
        stale: undefined,
      });
    });

    it("rejects invalid enabled value", async () => {
      const res = makeRes();
      await expect(
        listServices(makeReq({ query: { enabled: "maybe" } }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });

  describe("getService", () => {
    it("returns the service body for a valid id", async () => {
      const res = makeRes();
      servicesService.getService.mockResolvedValue({
        id: "svc",
        enabled: true,
      });

      await getService(makeReq({ params: { serviceId: "svc" } }), cast(res));

      expect(servicesService.getService).toHaveBeenCalledWith("svc");
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ id: "svc", enabled: true });
    });

    it("rejects when serviceId is missing", async () => {
      const res = makeRes();
      await expect(
        getService(makeReq({ params: {} }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });

  describe("getServiceConfiguration", () => {
    it("wraps the config under { config }", async () => {
      const res = makeRes();
      servicesService.getServiceConfig.mockResolvedValue({ foo: "bar" });

      await getServiceConfiguration(
        makeReq({ params: { serviceId: "svc" } }),
        cast(res),
      );

      expect(servicesService.getServiceConfig).toHaveBeenCalledWith("svc");
      expect(res.json).toHaveBeenCalledWith({ config: { foo: "bar" } });
    });
  });

  describe("getServiceConfigurationSchema", () => {
    it("wraps the schema under { configSchema }", async () => {
      const res = makeRes();
      servicesService.getServiceConfigSchema.mockResolvedValue({
        type: "object",
      });

      await getServiceConfigurationSchema(
        makeReq({ params: { serviceId: "svc" } }),
        cast(res),
      );

      expect(res.json).toHaveBeenCalledWith({
        configSchema: { type: "object" },
      });
    });
  });

  describe("getServiceSecrets", () => {
    it("returns the presence mask", async () => {
      const res = makeRes();
      servicesService.getServiceSecretsPresence.mockResolvedValue({
        present: ["/apiKey", "/token"],
      });

      await getServiceSecrets(
        makeReq({ params: { serviceId: "svc" } }),
        cast(res),
      );

      expect(res.json).toHaveBeenCalledWith({
        present: ["/apiKey", "/token"],
      });
    });
  });

  describe("getServiceSecretsSchema", () => {
    it("wraps the schema under { secretsSchema }", async () => {
      const res = makeRes();
      servicesService.getServiceSecretsSchema.mockResolvedValue({
        type: "object",
      });

      await getServiceSecretsSchema(
        makeReq({ params: { serviceId: "svc" } }),
        cast(res),
      );

      expect(res.json).toHaveBeenCalledWith({
        secretsSchema: { type: "object" },
      });
    });
  });

  describe("patchServiceConfiguration", () => {
    it("applies a JSON Patch and returns the resulting config", async () => {
      const res = makeRes();
      const patch = [{ op: "replace", path: "/foo", value: "bar" }] as const;
      servicesService.patchServiceConfig.mockResolvedValue(undefined);
      servicesService.getServiceConfig.mockResolvedValue({ foo: "bar" });

      await patchServiceConfiguration(
        makeReq({ params: { serviceId: "svc" }, body: patch }),
        cast(res),
      );

      expect(servicesService.patchServiceConfig).toHaveBeenCalledWith({
        id: "svc",
        patch,
      });
      expect(servicesService.getServiceConfig).toHaveBeenCalledWith("svc");
      expect(res.json).toHaveBeenCalledWith({ config: { foo: "bar" } });
    });

    it.each([
      [{ op: "add", path: "/x", value: 1 }],
      [{ op: "remove", path: "/x" }],
      [{ op: "replace", path: "/x", value: 2 }],
      [{ op: "move", path: "/x", from: "/y" }],
      [{ op: "copy", path: "/x", from: "/y" }],
      [{ op: "test", path: "/x", value: 3 }],
    ])("accepts %j operation", async (operation) => {
      const res = makeRes();
      servicesService.patchServiceConfig.mockResolvedValue(undefined);
      servicesService.getServiceConfig.mockResolvedValue({});

      await patchServiceConfiguration(
        makeReq({ params: { serviceId: "svc" }, body: [operation] }),
        cast(res),
      );

      expect(servicesService.patchServiceConfig).toHaveBeenCalledWith({
        id: "svc",
        patch: [operation],
      });
    });

    it.each([
      [{ body: {}, why: "body not an array" }],
      [{ body: [{ op: "unknown", path: "/x" }], why: "unknown op" }],
      [{ body: [{ op: "add", value: 1 }], why: "add missing path" }],
      [{ body: [{ op: "remove" }], why: "remove missing path" }],
      [{ body: [{ op: "move", path: "/x" }], why: "move missing from" }],
      [{ body: [{ op: "add", path: "", value: 1 }], why: "empty path" }],
    ])("rejects $why", async ({ body }) => {
      const res = makeRes();
      await expect(
        patchServiceConfiguration(
          makeReq({ params: { serviceId: "svc" }, body }),
          cast(res),
        ),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });

  describe("patchServiceSecrets", () => {
    it("applies the patch and returns updated:true", async () => {
      const res = makeRes();
      const patch = [{ op: "add", path: "/token", value: "x" }];
      servicesService.patchServiceSecrets.mockResolvedValue(undefined);

      await patchServiceSecrets(
        makeReq({ params: { serviceId: "svc" }, body: patch }),
        cast(res),
      );

      expect(servicesService.patchServiceSecrets).toHaveBeenCalledWith({
        id: "svc",
        patch,
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ updated: true });
    });

    it("does not return the secret contents", async () => {
      const res = makeRes();
      servicesService.patchServiceSecrets.mockResolvedValue(undefined);

      await patchServiceSecrets(
        makeReq({
          params: { serviceId: "svc" },
          body: [{ op: "add", path: "/k", value: "v" }],
        }),
        cast(res),
      );

      const responseBody = res.json.mock.calls.at(-1)?.[0];
      expect(JSON.stringify(responseBody)).not.toContain("v");
    });

    it("rejects non-array bodies", async () => {
      const res = makeRes();
      await expect(
        patchServiceSecrets(
          makeReq({ params: { serviceId: "svc" }, body: {} }),
          cast(res),
        ),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });

  describe("createServiceDirect", () => {
    it("creates a service and returns 201 { id }", async () => {
      const res = makeRes();
      const body = {
        id: "svc",
        url: "https://example.com/svc.json",
        adapter: "adapter-a",
      };
      servicesService.createServiceDirect.mockResolvedValue(undefined);

      await createServiceDirect(makeReq({ body }), cast(res));

      expect(servicesService.createServiceDirect).toHaveBeenCalledWith(body);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ id: "svc" });
    });

    it("trims whitespace from id/url/adapter", async () => {
      const res = makeRes();
      servicesService.createServiceDirect.mockResolvedValue(undefined);

      await createServiceDirect(
        makeReq({
          body: {
            id: "  svc  ",
            url: "  https://example.com  ",
            adapter: "  a  ",
          },
        }),
        cast(res),
      );

      expect(servicesService.createServiceDirect).toHaveBeenCalledWith({
        id: "svc",
        url: "https://example.com",
        adapter: "a",
      });
      expect(res.json).toHaveBeenCalledWith({ id: "svc" });
    });

    it.each([
      { body: {}, why: "missing all fields" },
      { body: { id: "svc" }, why: "missing url and adapter" },
      { body: { id: "", url: "s", adapter: "a" }, why: "empty id" },
      { body: { id: "svc", url: "  ", adapter: "a" }, why: "blank url" },
      { body: { id: "svc", url: "s", adapter: "" }, why: "empty adapter" },
      { body: { id: 1, url: "s", adapter: "a" }, why: "non-string id" },
      { body: "not-an-object", why: "non-object body" },
    ])("rejects $why", async ({ body }) => {
      const res = makeRes();
      await expect(
        createServiceDirect(makeReq({ body }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });

  describe("installServiceRegistry", () => {
    it("creates a service from registry and returns 201", async () => {
      const res = makeRes();
      const body = {
        source: "https://registry.example.com/svc",
      };
      servicesService.createServiceFromRegistry.mockResolvedValue(
        "svc-from-registry",
      );

      await installServiceRegistry(makeReq({ body }), cast(res));

      expect(servicesService.createServiceFromRegistry).toHaveBeenCalledWith(
        body,
      );
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ id: "svc-from-registry" });
    });

    it("rejects an empty source", async () => {
      const res = makeRes();
      await expect(
        installServiceRegistry(makeReq({ body: { source: "" } }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
      expect(servicesService.createServiceFromRegistry).not.toHaveBeenCalled();
    });
  });

  describe("patchService", () => {
    it("patches a service via direct URL and returns { updated: boolean }", async () => {
      const res = makeRes();
      servicesService.patchService.mockResolvedValue({ updated: true });

      await patchService(
        makeReq({
          params: { serviceId: "svc" },
          body: { url: "https://example.com/new.json" },
        }),
        cast(res),
      );

      expect(servicesService.patchService).toHaveBeenCalledWith(
        "svc",
        "https://example.com/new.json",
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ updated: true });
    });

    it("rejects an empty url", async () => {
      const res = makeRes();
      await expect(
        patchService(
          makeReq({
            params: { serviceId: "svc" },
            body: { url: "" },
          }),
          cast(res),
        ),
      ).rejects.toBeInstanceOf(HttpError);
      expect(servicesService.patchService).not.toHaveBeenCalled();
    });
  });

  describe("updateService", () => {
    it("triggers update and returns { id, updated: true }", async () => {
      const res = makeRes();
      servicesService.updateService.mockResolvedValue(undefined);

      await updateService(makeReq({ params: { serviceId: "svc" } }), cast(res));

      expect(servicesService.updateService).toHaveBeenCalledWith("svc");
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ id: "svc", updated: true });
    });
  });

  describe("setServiceEnabled", () => {
    it.each([true, false])(
      "forwards enabled=%s and echoes it back",
      async (enabled) => {
        const res = makeRes();
        servicesService.setServiceEnabled.mockResolvedValue(undefined);

        await setServiceEnabled(
          makeReq({
            params: { serviceId: "svc" },
            body: { enabled },
          }),
          cast(res),
        );

        expect(servicesService.setServiceEnabled).toHaveBeenCalledWith({
          id: "svc",
          enabled,
        });
        expect(res.json).toHaveBeenCalledWith({ id: "svc", enabled });
      },
    );

    it.each([
      { body: {}, why: "missing enabled" },
      { body: { enabled: "true" }, why: "string enabled" },
      { body: { enabled: 1 }, why: "numeric enabled" },
      { body: "nope", why: "non-object body" },
    ])("rejects $why", async ({ body }) => {
      const res = makeRes();
      await expect(
        setServiceEnabled(
          makeReq({ params: { serviceId: "svc" }, body }),
          cast(res),
        ),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });

  describe("deleteService", () => {
    it("returns 204 with no body", async () => {
      const res = makeRes();
      servicesService.deleteService.mockResolvedValue(undefined);

      await deleteService(makeReq({ params: { serviceId: "svc" } }), cast(res));

      expect(servicesService.deleteService).toHaveBeenCalledWith("svc");
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalledWith();
      expect(res.json).not.toHaveBeenCalled();
    });
  });
});
