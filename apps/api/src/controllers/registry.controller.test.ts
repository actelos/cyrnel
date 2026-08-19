import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addRegistry,
  browseDefinitions,
  browseModules,
  createRegistry,
  deleteRegistry,
  listRegistries,
  refreshRegistry,
} from "@/controllers/registry.controller";
import { HttpError } from "@/models/error.model";

const registriesService = {
  createRegistry: vi.fn(),
  addRegistry: vi.fn(),
  refreshRegistry: vi.fn(),
  browseDefinitions: vi.fn(),
  browseModules: vi.fn(),
  listRegistries: vi.fn(),
  getRegistry: vi.fn(),
  deleteRegistry: vi.fn(),
};

interface MockResponse {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  type: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

const makeRes = (): MockResponse => {
  const res = {} as MockResponse;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.type = vi.fn().mockReturnValue(res);
  res.set = vi.fn().mockReturnValue(res);
  return res;
};

const makeReq = (overrides: Record<string, unknown> = {}): Request =>
  ({
    app: { locals: { registriesService } },
    params: {},
    query: {},
    body: {},
    ...overrides,
  }) as unknown as Request;

const cast = (res: MockResponse) => res as unknown as Response;

const sampleRecord = {
  id: "github",
  baseUrl: "https://registry.github.com/",
  lastSyncedAt: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

describe("registry.controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("locals wiring", () => {
    it("throws if registriesService is missing from app.locals", async () => {
      const res = makeRes();
      const req = {
        app: { locals: {} },
        params: {},
        query: {},
        body: {},
      } as unknown as Request;

      await expect(listRegistries(req, cast(res))).rejects.toThrow(
        /RegistriesService not configured/,
      );
    });
  });

  describe("listRegistries", () => {
    it("returns 200 with the paginated envelope", async () => {
      const res = makeRes();
      const page = {
        items: [sampleRecord],
        nextCursor: null,
        hasMore: false,
      };
      registriesService.listRegistries.mockResolvedValue(page);

      await listRegistries(makeReq(), cast(res));

      expect(registriesService.listRegistries).toHaveBeenCalledWith({
        limit: 20,
        cursor: undefined,
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(page);
    });

    it("forwards cursor and limit query params", async () => {
      const res = makeRes();
      registriesService.listRegistries.mockResolvedValue({
        items: [],
        nextCursor: null,
        hasMore: false,
      });

      await listRegistries(
        makeReq({ query: { cursor: "abc", limit: "5" } }),
        cast(res),
      );

      expect(registriesService.listRegistries).toHaveBeenCalledWith({
        limit: 5,
        cursor: "abc",
      });
    });

    it.each([
      { query: { limit: "0" }, why: "limit below minimum" },
      { query: { limit: "-1" }, why: "negative limit" },
      { query: { limit: "1.5" }, why: "fractional limit" },
      { query: { limit: "abc" }, why: "non-numeric limit" },
    ])("rejects $why", async ({ query }) => {
      const res = makeRes();
      await expect(
        listRegistries(makeReq({ query }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
      expect(registriesService.listRegistries).not.toHaveBeenCalled();
    });
  });

  describe("createRegistry", () => {
    it("creates a registry and returns 201 with the record", async () => {
      const res = makeRes();
      const body = {
        id: "github",
        baseUrl: "https://registry.github.com",
      };
      registriesService.createRegistry.mockResolvedValue(sampleRecord);

      await createRegistry(makeReq({ body }), cast(res));

      expect(registriesService.createRegistry).toHaveBeenCalledWith(body);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(sampleRecord);
    });

    it("trims id and baseUrl", async () => {
      const res = makeRes();
      registriesService.createRegistry.mockResolvedValue(sampleRecord);

      await createRegistry(
        makeReq({
          body: {
            id: "  github  ",
            baseUrl: "  https://registry.github.com  ",
          },
        }),
        cast(res),
      );

      expect(registriesService.createRegistry).toHaveBeenCalledWith({
        id: "github",
        baseUrl: "https://registry.github.com",
      });
    });

    it.each([
      { body: {}, why: "missing all fields" },
      { body: { id: "github" }, why: "missing baseUrl" },
      { body: { baseUrl: "https://x.com" }, why: "missing id" },
      { body: { id: "not a slug", baseUrl: "https://x.com" }, why: "bad slug" },
      { body: { id: "ok", baseUrl: "ftp://x.com" }, why: "non-http scheme" },
      { body: { id: "ok", baseUrl: "not a url" }, why: "invalid url" },
      { body: "not-an-object", why: "non-object body" },
    ])("rejects $why", async ({ body }) => {
      const res = makeRes();
      await expect(
        createRegistry(makeReq({ body }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
      expect(registriesService.createRegistry).not.toHaveBeenCalled();
    });
  });

  describe("deleteRegistry", () => {
    it("returns 204 with no body", async () => {
      const res = makeRes();
      registriesService.deleteRegistry.mockResolvedValue(undefined);

      await deleteRegistry(makeReq({ params: { id: "github" } }), cast(res));

      expect(registriesService.deleteRegistry).toHaveBeenCalledWith("github");
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalledWith();
      expect(res.json).not.toHaveBeenCalled();
    });

    it("rejects when id is missing", async () => {
      const res = makeRes();
      await expect(
        deleteRegistry(makeReq({ params: {} }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });
});

const samplePage = {
  entries: [
    {
      id: "github",
      name: "GitHub",
      source: "https://registry.github.com/definitions/github",
      kind: "openapi@3.0",
    },
  ],
  nextCursor: null,
};

describe("addRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("adds a registry from baseUrl alone", async () => {
    const res = makeRes();
    registriesService.addRegistry.mockResolvedValue(sampleRecord);

    await addRegistry(
      makeReq({ body: { baseUrl: "  https://registry.example.com  " } }),
      cast(res),
    );

    expect(registriesService.addRegistry).toHaveBeenCalledWith(
      "https://registry.example.com",
      undefined,
      undefined,
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(sampleRecord);
  });

  it("forwards an id override", async () => {
    const res = makeRes();
    registriesService.addRegistry.mockResolvedValue(sampleRecord);

    await addRegistry(
      makeReq({
        body: { baseUrl: "https://registry.example.com", id: "  alias  " },
      }),
      cast(res),
    );

    expect(registriesService.addRegistry).toHaveBeenCalledWith(
      "https://registry.example.com",
      "alias",
      undefined,
    );
  });

  it.each([
    { body: {}, why: "missing baseUrl" },
    { body: { baseUrl: "not a url" }, why: "invalid baseUrl" },
    { body: { baseUrl: "ftp://x.com" }, why: "non-http scheme" },
    {
      body: { baseUrl: "https://x.com", id: "not a slug" },
      why: "bad id slug",
    },
    { body: "nope", why: "non-object body" },
  ])("rejects $why", async ({ body }) => {
    const res = makeRes();
    await expect(
      addRegistry(makeReq({ body }), cast(res)),
    ).rejects.toBeInstanceOf(HttpError);
    expect(registriesService.addRegistry).not.toHaveBeenCalled();
  });
});

describe("refreshRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("returns 200 with the updated record", async () => {
    const res = makeRes();
    registriesService.refreshRegistry.mockResolvedValue(sampleRecord);

    await refreshRegistry(makeReq({ params: { id: "github" } }), cast(res));

    expect(registriesService.refreshRegistry).toHaveBeenCalledWith("github");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(sampleRecord);
  });

  it("rejects a missing id", async () => {
    const res = makeRes();
    await expect(
      refreshRegistry(makeReq({ params: {} }), cast(res)),
    ).rejects.toBeInstanceOf(HttpError);
  });
});

describe("browseDefinitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("returns the definitions envelope and forwards params", async () => {
    const res = makeRes();
    registriesService.browseDefinitions.mockResolvedValue(samplePage);

    await browseDefinitions(
      makeReq({
        params: { id: "github" },
        query: { query: "git", kind: "github", limit: "25", cursor: "abc" },
      }),
      cast(res),
    );

    expect(registriesService.browseDefinitions).toHaveBeenCalledWith("github", {
      query: "git",
      kind: "github",
      limit: 25,
      cursor: "abc",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      definitions: samplePage.entries,
      nextCursor: null,
    });
  });

  it("accepts an empty query string", async () => {
    const res = makeRes();
    registriesService.browseDefinitions.mockResolvedValue({
      entries: [],
      nextCursor: null,
    });

    await browseDefinitions(makeReq({ params: { id: "github" } }), cast(res));

    expect(registriesService.browseDefinitions).toHaveBeenCalledWith("github", {
      query: undefined,
      kind: undefined,
      limit: undefined,
      cursor: undefined,
    });
  });

  it.each([
    { query: { query: "" }, why: "empty query" },
    { query: { limit: "0" }, why: "zero limit" },
    { query: { limit: "201" }, why: "limit above max" },
    { query: { limit: "abc" }, why: "non-numeric limit" },
  ])("rejects $why", async ({ query }) => {
    const res = makeRes();
    await expect(
      browseDefinitions(makeReq({ params: { id: "x" }, query }), cast(res)),
    ).rejects.toBeInstanceOf(HttpError);
    expect(registriesService.browseDefinitions).not.toHaveBeenCalled();
  });
});

describe("browseModules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("returns the modules envelope and forwards params", async () => {
    const res = makeRes();
    registriesService.browseModules.mockResolvedValue(samplePage);

    await browseModules(
      makeReq({ params: { id: "github" }, query: { type: "adapter" } }),
      cast(res),
    );

    expect(registriesService.browseModules).toHaveBeenCalledWith("github", {
      type: "adapter",
      query: undefined,
      limit: undefined,
      cursor: undefined,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      modules: samplePage.entries,
      nextCursor: null,
    });
  });

  it("rejects an invalid type", async () => {
    const res = makeRes();
    await expect(
      browseModules(
        makeReq({ params: { id: "x" }, query: { type: "wat" } }),
        cast(res),
      ),
    ).rejects.toBeInstanceOf(HttpError);
    expect(registriesService.browseModules).not.toHaveBeenCalled();
  });
});
