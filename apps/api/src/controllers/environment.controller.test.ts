import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getEnvironmentDocs } from "@/controllers/environment.controller";
import { HttpError } from "@/models/error.model";

const moduleService = {
  generateEnvironmentDocs: vi.fn(),
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
    app: { locals: { moduleService } },
    params: {},
    query: {},
    body: {},
    ...overrides,
  }) as unknown as Request;

const cast = (res: MockResponse) => res as unknown as Response;

describe("environment.controller", () => {
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

      await expect(getEnvironmentDocs(req, cast(res))).rejects.toThrow(
        /ModuleService not configured/,
      );
    });
  });

  describe("getEnvironmentDocs", () => {
    it("returns the generated docs as markdown", async () => {
      const res = makeRes();
      moduleService.generateEnvironmentDocs.mockResolvedValue(
        "# Environment\n\nBindings...",
      );

      await getEnvironmentDocs(makeReq(), cast(res));

      expect(moduleService.generateEnvironmentDocs).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.type).toHaveBeenCalledWith("text/markdown; charset=utf-8");
      expect(res.send).toHaveBeenCalledWith("# Environment\n\nBindings...");
    });

    it("returns an empty string body when the service yields one", async () => {
      const res = makeRes();
      moduleService.generateEnvironmentDocs.mockResolvedValue("");

      await getEnvironmentDocs(makeReq(), cast(res));

      expect(res.send).toHaveBeenCalledWith("");
    });

    it("propagates HttpError from the service (e.g. no active environment)", async () => {
      const res = makeRes();
      moduleService.generateEnvironmentDocs.mockRejectedValue(
        new HttpError(503, "No environment module is active."),
      );

      await expect(
        getEnvironmentDocs(makeReq(), cast(res)),
      ).rejects.toMatchObject({
        statusCode: 503,
        message: "No environment module is active.",
      });
    });
  });
});
