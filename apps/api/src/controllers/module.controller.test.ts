import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getModule,
  getModuleConfiguration,
  getModuleConfigurationSchema,
  getModuleSecretsSchema,
  listModules,
  patchModuleConfiguration,
  patchModuleSecrets,
  reloadModules,
  setModuleEnabled,
} from "@/controllers/module.controller";
import { HttpError } from "@/models/error.model";

const moduleService = {
  list: vi.fn(),
  get: vi.fn(),
  setEnabled: vi.fn(),
  reload: vi.fn(),
  getConfig: vi.fn(),
  getConfigSchema: vi.fn(),
  getSecretsSchema: vi.fn(),
  patchConfig: vi.fn(),
  patchSecrets: vi.fn(),
};

interface MockResponse {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  type: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

const makeRes = (): MockResponse => {
  const res = {} as MockResponse;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.end = vi.fn().mockReturnValue(res);
  res.type = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
};

const makeReq = (overrides: Record<string, unknown> = {}): Request =>
  ({
    app: { locals: { moduleService } },
    params: {},
    query: {},
    body: {},
    ...overrides,
  }) as unknown as Request;

const cast = (res: MockResponse) => res as unknown as Response;

describe("module.controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("locals wiring", () => {
    it("throws if moduleService is missing from app.locals", async () => {
      const res = makeRes();
      const req = {
        app: { locals: {} },
        params: {},
        query: {},
        body: {},
      } as unknown as Request;

      await expect(listModules(req, cast(res))).rejects.toThrow(
        /ModuleService not configured/,
      );
    });
  });

  describe("listModules", () => {
    it("returns modules wrapped under { modules } with empty filters by default", async () => {
      const res = makeRes();
      moduleService.list.mockResolvedValue([]);

      await listModules(makeReq(), cast(res));

      expect(moduleService.list).toHaveBeenCalledWith({
        query: undefined,
        type: undefined,
        isBuiltin: undefined,
        enabled: undefined,
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ modules: [] });
    });

    it("forwards all filters at once", async () => {
      const res = makeRes();
      moduleService.list.mockResolvedValue([{ id: "m1" }]);

      await listModules(
        makeReq({
          query: {
            query: "search",
            type: "adapter",
            isBuiltin: "true",
            enabled: "false",
          },
        }),
        cast(res),
      );

      expect(moduleService.list).toHaveBeenCalledWith({
        query: "search",
        type: "adapter",
        isBuiltin: true,
        enabled: false,
      });
    });

    it("trims query and drops it when empty", async () => {
      const res = makeRes();
      moduleService.list.mockResolvedValue([]);

      await listModules(makeReq({ query: { query: "   " } }), cast(res));

      expect(moduleService.list).toHaveBeenCalledWith({
        query: undefined,
        type: undefined,
        isBuiltin: undefined,
        enabled: undefined,
      });
    });

    it.each([
      ["adapter", "adapter"],
      ["environment", "environment"],
    ])("accepts type=%s", async (raw, expected) => {
      const res = makeRes();
      moduleService.list.mockResolvedValue([]);

      await listModules(makeReq({ query: { type: raw } }), cast(res));

      expect(moduleService.list).toHaveBeenCalledWith(
        expect.objectContaining({ type: expected }),
      );
    });

    it("rejects an unknown type", async () => {
      const res = makeRes();
      await expect(
        listModules(makeReq({ query: { type: "bogus" } }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
    });

    it.each([
      ["true", true],
      ["false", false],
      ["  True ", true],
      ["FALSE", false],
    ])("coerces isBuiltin=%s -> %s", async (raw, expected) => {
      const res = makeRes();
      moduleService.list.mockResolvedValue([]);

      await listModules(makeReq({ query: { isBuiltin: raw } }), cast(res));

      expect(moduleService.list).toHaveBeenCalledWith(
        expect.objectContaining({ isBuiltin: expected }),
      );
    });

    it("rejects invalid isBuiltin", async () => {
      const res = makeRes();
      await expect(
        listModules(makeReq({ query: { isBuiltin: "maybe" } }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
    });

    it.each([
      ["true", true],
      ["false", false],
      ["null", null],
      ["  Null ", null],
    ])("coerces enabled=%s -> %s", async (raw, expected) => {
      const res = makeRes();
      moduleService.list.mockResolvedValue([]);

      await listModules(makeReq({ query: { enabled: raw } }), cast(res));

      expect(moduleService.list).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: expected }),
      );
    });

    it("rejects invalid enabled value", async () => {
      const res = makeRes();
      await expect(
        listModules(makeReq({ query: { enabled: "maybe" } }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });

  describe("getModule", () => {
    it("returns the module body when found", async () => {
      const res = makeRes();
      moduleService.get.mockResolvedValue({
        id: "m1",
        name: "m1",
        type: "adapter",
        enabled: true,
        orphaned: false,
      });

      await getModule(makeReq({ params: { moduleId: "m1" } }), cast(res));

      expect(moduleService.get).toHaveBeenCalledWith("m1");
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        id: "m1",
        name: "m1",
        type: "adapter",
        enabled: true,
        orphaned: false,
      });
    });

    it("trims the moduleId before lookup", async () => {
      const res = makeRes();
      moduleService.get.mockResolvedValue({ id: "m1" });

      await getModule(makeReq({ params: { moduleId: "  m1  " } }), cast(res));

      expect(moduleService.get).toHaveBeenCalledWith("m1");
    });

    it("throws 404 when not found", async () => {
      const res = makeRes();
      moduleService.get.mockResolvedValue(undefined);

      await expect(
        getModule(makeReq({ params: { moduleId: "missing" } }), cast(res)),
      ).rejects.toMatchObject({
        statusCode: 404,
        message: "Module 'missing' not found.",
      });
    });

    it.each(["", "   "])("rejects empty moduleId=%s", async (moduleId) => {
      const res = makeRes();
      await expect(
        getModule(makeReq({ params: { moduleId } }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });

  describe("setModuleEnabled", () => {
    it("forwards enabled=true to the service and responds 200", async () => {
      const res = makeRes();
      moduleService.setEnabled.mockResolvedValue(undefined);

      await setModuleEnabled(
        makeReq({
          params: { moduleId: "m1" },
          body: { enabled: true },
        }),
        cast(res),
      );

      expect(moduleService.setEnabled).toHaveBeenCalledWith({
        id: "m1",
        enabled: true,
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.end).toHaveBeenCalled();
    });

    it("forwards enabled=false to the service and responds 200", async () => {
      const res = makeRes();
      moduleService.setEnabled.mockResolvedValue(undefined);

      await setModuleEnabled(
        makeReq({
          params: { moduleId: "m1" },
          body: { enabled: false },
        }),
        cast(res),
      );

      expect(moduleService.setEnabled).toHaveBeenCalledWith({
        id: "m1",
        enabled: false,
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.end).toHaveBeenCalled();
    });

    it("propagates errors thrown by setEnabled", async () => {
      const res = makeRes();
      moduleService.setEnabled.mockRejectedValue(
        new HttpError(409, "Module 'm1' is orphaned and cannot be enabled."),
      );

      await expect(
        setModuleEnabled(
          makeReq({
            params: { moduleId: "m1" },
            body: { enabled: true },
          }),
          cast(res),
        ),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "Module 'm1' is orphaned and cannot be enabled.",
      });
    });

    it.each([
      { body: {}, why: "missing enabled" },
      { body: { enabled: "true" }, why: "string enabled" },
      { body: { enabled: 1 }, why: "numeric enabled" },
      { body: null, why: "null body" },
    ])("rejects $why", async ({ body }) => {
      const res = makeRes();
      await expect(
        setModuleEnabled(
          makeReq({ params: { moduleId: "m1" }, body }),
          cast(res),
        ),
      ).rejects.toBeInstanceOf(HttpError);
      expect(moduleService.setEnabled).not.toHaveBeenCalled();
    });
  });

  describe("reloadModules", () => {
    it("reloads and responds with an empty 200", async () => {
      const res = makeRes();
      moduleService.reload.mockResolvedValue(null);

      await reloadModules(makeReq(), cast(res));

      expect(moduleService.reload).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.end).toHaveBeenCalled();
    });

    it("propagates errors from reload", async () => {
      const res = makeRes();
      moduleService.reload.mockRejectedValue(
        new HttpError(503, "ModuleService has not been initialized."),
      );

      await expect(reloadModules(makeReq(), cast(res))).rejects.toMatchObject({
        statusCode: 503,
      });
    });
  });

  describe("getModuleConfiguration", () => {
    it("wraps the config under { config }", async () => {
      const res = makeRes();
      moduleService.getConfig.mockResolvedValue({ foo: "bar" });

      await getModuleConfiguration(
        makeReq({ params: { moduleId: "m1" } }),
        cast(res),
      );

      expect(moduleService.getConfig).toHaveBeenCalledWith("m1");
      expect(res.json).toHaveBeenCalledWith({ config: { foo: "bar" } });
    });

    it("rejects an empty moduleId", async () => {
      const res = makeRes();
      await expect(
        getModuleConfiguration(
          makeReq({ params: { moduleId: "   " } }),
          cast(res),
        ),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });

  describe("getModuleConfigurationSchema", () => {
    it("wraps the schema under { configSchema }", async () => {
      const res = makeRes();
      moduleService.getConfigSchema.mockReturnValue({ type: "object" });

      await getModuleConfigurationSchema(
        makeReq({ params: { moduleId: "m1" } }),
        cast(res),
      );

      expect(res.json).toHaveBeenCalledWith({
        configSchema: { type: "object" },
      });
    });

    it("propagates 404 from the service", async () => {
      const res = makeRes();
      moduleService.getConfigSchema.mockImplementation(() => {
        throw new HttpError(404, "Module 'ghost' is not registered.");
      });

      await expect(
        getModuleConfigurationSchema(
          makeReq({ params: { moduleId: "ghost" } }),
          cast(res),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe("getModuleSecretsSchema", () => {
    it("wraps the schema under { secretsSchema }", async () => {
      const res = makeRes();
      moduleService.getSecretsSchema.mockReturnValue({ type: "object" });

      await getModuleSecretsSchema(
        makeReq({ params: { moduleId: "m1" } }),
        cast(res),
      );

      expect(res.json).toHaveBeenCalledWith({
        secretsSchema: { type: "object" },
      });
    });
  });

  describe("patchModuleConfiguration", () => {
    it("applies a JSON Patch and returns the resulting config", async () => {
      const res = makeRes();
      const patch = [{ op: "replace", path: "/foo", value: "bar" }] as const;
      moduleService.patchConfig.mockResolvedValue(undefined);
      moduleService.getConfig.mockResolvedValue({ foo: "bar" });

      await patchModuleConfiguration(
        makeReq({ params: { moduleId: "m1" }, body: patch }),
        cast(res),
      );

      expect(moduleService.patchConfig).toHaveBeenCalledWith({
        id: "m1",
        patch,
      });
      expect(moduleService.getConfig).toHaveBeenCalledWith("m1");
      expect(res.json).toHaveBeenCalledWith({ config: { foo: "bar" } });
    });

    it("accepts a root JSON Pointer path", async () => {
      const res = makeRes();
      const patch = [{ op: "replace", path: "", value: { foo: "bar" } }];
      moduleService.patchConfig.mockResolvedValue(undefined);
      moduleService.getConfig.mockResolvedValue({ foo: "bar" });

      await patchModuleConfiguration(
        makeReq({ params: { moduleId: "m1" }, body: patch }),
        cast(res),
      );

      expect(moduleService.patchConfig).toHaveBeenCalledWith({
        id: "m1",
        patch,
      });
    });

    it.each([
      [{ body: {}, why: "body not an array" }],
      [{ body: [{ op: "unknown", path: "/x" }], why: "unknown op" }],
      [{ body: [{ op: "add", value: 1 }], why: "add missing path" }],
      [{ body: [{ op: "remove" }], why: "remove missing path" }],
      [{ body: [{ op: "move", path: "/x" }], why: "move missing from" }],
    ])("rejects $why", async ({ body }) => {
      const res = makeRes();
      await expect(
        patchModuleConfiguration(
          makeReq({ params: { moduleId: "m1" }, body }),
          cast(res),
        ),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });

  describe("patchModuleSecrets", () => {
    it("applies the patch and returns updated:true", async () => {
      const res = makeRes();
      const patch = [{ op: "add", path: "/token", value: "x" }];
      moduleService.patchSecrets.mockResolvedValue(undefined);

      await patchModuleSecrets(
        makeReq({ params: { moduleId: "m1" }, body: patch }),
        cast(res),
      );

      expect(moduleService.patchSecrets).toHaveBeenCalledWith({
        id: "m1",
        patch,
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ updated: true });
    });

    it("accepts root JSON Pointer paths for copy sources", async () => {
      const res = makeRes();
      const patch = [{ op: "copy", from: "", path: "/tokenCopy" }];
      moduleService.patchSecrets.mockResolvedValue(undefined);

      await patchModuleSecrets(
        makeReq({ params: { moduleId: "m1" }, body: patch }),
        cast(res),
      );

      expect(moduleService.patchSecrets).toHaveBeenCalledWith({
        id: "m1",
        patch,
      });
    });

    it("does not return the secret contents", async () => {
      const res = makeRes();
      moduleService.patchSecrets.mockResolvedValue(undefined);

      await patchModuleSecrets(
        makeReq({
          params: { moduleId: "m1" },
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
        patchModuleSecrets(
          makeReq({ params: { moduleId: "m1" }, body: {} }),
          cast(res),
        ),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });
});
