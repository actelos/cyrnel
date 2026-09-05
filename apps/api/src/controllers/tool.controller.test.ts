import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getTool, getToolDocs, listTools } from "@/controllers/tool.controller";
import { HttpError } from "@/models/error.model";

const servicesService = {
  listTools: vi.fn(),
  getTool: vi.fn(),
  getToolDocs: vi.fn(),
};

interface MockResponse {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  type: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

const makeRes = (): MockResponse => {
  const res = {} as MockResponse;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.type = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
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

describe("tool.controller", () => {
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

      await expect(listTools(req, cast(res))).rejects.toThrow(
        /ServicesService not configured/,
      );
    });
  });

  describe("listTools", () => {
    it("returns the paginated envelope with no filters by default", async () => {
      const res = makeRes();
      const envelope = { items: [], nextCursor: null, hasMore: false };
      servicesService.listTools.mockResolvedValue(envelope);

      await listTools(makeReq(), cast(res));

      expect(servicesService.listTools).toHaveBeenCalledWith({
        serviceId: undefined,
        query: undefined,
        limit: 20,
        enabled: undefined,
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(envelope);
    });

    it("forwards serviceId, query, limit, and enabled", async () => {
      const res = makeRes();
      const envelope = {
        items: [{ id: "t1" }],
        nextCursor: null,
        hasMore: false,
      };
      servicesService.listTools.mockResolvedValue(envelope);

      await listTools(
        makeReq({
          query: {
            serviceId: "svc",
            query: "search",
            limit: "10",
            enabled: "true",
          },
        }),
        cast(res),
      );

      expect(servicesService.listTools).toHaveBeenCalledWith({
        serviceId: "svc",
        query: "search",
        limit: 10,
        enabled: true,
      });
      expect(res.json).toHaveBeenCalledWith(envelope);
    });

    it("trims serviceId and query, and drops them when empty after trim", async () => {
      const res = makeRes();
      servicesService.listTools.mockResolvedValue({
        items: [],
        nextCursor: null,
        hasMore: false,
      });

      await listTools(
        makeReq({
          query: { serviceId: "  ", query: "   " },
        }),
        cast(res),
      );

      expect(servicesService.listTools).toHaveBeenCalledWith({
        serviceId: undefined,
        query: undefined,
        limit: 20,
        enabled: undefined,
      });
    });

    it.each([
      ["true", true],
      ["false", false],
    ])("coerces enabled=%s -> %s", async (raw, expected) => {
      const res = makeRes();
      servicesService.listTools.mockResolvedValue([]);

      await listTools(makeReq({ query: { enabled: raw } }), cast(res));

      expect(servicesService.listTools).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: expected }),
      );
    });

    it.each(["maybe", "TRUE", "1", ""])("rejects enabled=%s", async (raw) => {
      const res = makeRes();
      await expect(
        listTools(makeReq({ query: { enabled: raw } }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
    });

    it.each(["0", "-1", "abc", "1.5"])("rejects limit=%s", async (raw) => {
      const res = makeRes();
      await expect(
        listTools(makeReq({ query: { limit: raw } }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
    });

    it("clamps an oversized limit to 100", async () => {
      const res = makeRes();
      servicesService.listTools.mockResolvedValue({
        items: [],
        nextCursor: null,
        hasMore: false,
      });

      await listTools(makeReq({ query: { limit: "1000" } }), cast(res));

      expect(servicesService.listTools).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 }),
      );
    });
  });

  describe("getTool", () => {
    it("returns the tool body", async () => {
      const res = makeRes();
      servicesService.getTool.mockResolvedValue({
        id: "t1",
        name: "t1",
        enabled: true,
      });

      await getTool(
        makeReq({ params: { serviceId: "svc", toolId: "t1" } }),
        cast(res),
      );

      expect(servicesService.getTool).toHaveBeenCalledWith({
        serviceId: "svc",
        toolId: "t1",
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        id: "t1",
        name: "t1",
        enabled: true,
      });
    });
  });

  describe("getToolDocs", () => {
    it("returns docs as markdown", async () => {
      const res = makeRes();
      servicesService.getToolDocs.mockResolvedValue("# Tool\n\nDescription");

      await getToolDocs(
        makeReq({ params: { serviceId: "svc", toolId: "t1" } }),
        cast(res),
      );

      expect(servicesService.getToolDocs).toHaveBeenCalledWith({
        serviceId: "svc",
        toolId: "t1",
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.type).toHaveBeenCalledWith("text/markdown; charset=utf-8");
      expect(res.send).toHaveBeenCalledWith("# Tool\n\nDescription");
    });
  });
});
