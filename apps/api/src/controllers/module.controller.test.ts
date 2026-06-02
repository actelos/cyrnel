import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getModule,
  listModules,
  reloadModules,
  setModuleEnabled,
} from "@/controllers/module.controller";
import { HttpError } from "@/models/error.model";

const moduleService = {
  list: vi.fn(),
  get: vi.fn(),
  setEnabled: vi.fn(),
  reload: vi.fn(),
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
    it("toggles enabled=true on a non-orphaned module and responds 200", async () => {
      const res = makeRes();
      moduleService.get.mockResolvedValue({
        id: "m1",
        orphaned: false,
      });
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

    it("allows disabling an orphaned module", async () => {
      const res = makeRes();
      moduleService.get.mockResolvedValue({
        id: "m1",
        orphaned: true,
      });
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

    it("throws 409 when enabling an orphaned module", async () => {
      const res = makeRes();
      moduleService.get.mockResolvedValue({
        id: "m1",
        orphaned: true,
      });

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
      expect(moduleService.setEnabled).not.toHaveBeenCalled();
    });

    it("throws 404 when the module does not exist", async () => {
      const res = makeRes();
      moduleService.get.mockResolvedValue(undefined);

      await expect(
        setModuleEnabled(
          makeReq({
            params: { moduleId: "missing" },
            body: { enabled: true },
          }),
          cast(res),
        ),
      ).rejects.toMatchObject({
        statusCode: 404,
        message: "Module 'missing' not found.",
      });
      expect(moduleService.setEnabled).not.toHaveBeenCalled();
    });

    it.each([
      { body: {}, why: "missing enabled" },
      { body: { enabled: "true" }, why: "string enabled" },
      { body: { enabled: 1 }, why: "numeric enabled" },
      { body: null, why: "null body" },
    ])("rejects $why", async ({ body }) => {
      const res = makeRes();
      moduleService.get.mockResolvedValue({ id: "m1", orphaned: false });
      await expect(
        setModuleEnabled(
          makeReq({ params: { moduleId: "m1" }, body }),
          cast(res),
        ),
      ).rejects.toBeInstanceOf(HttpError);
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
});
