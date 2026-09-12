import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addRegistry,
  browseDefinitions,
  browseModules,
  createRegistry,
  deleteRegistry,
  deleteRegistryAuth,
  getRegistryAuth,
  listRegistries,
  refreshRegistry,
  setRegistryAuth,
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
  getRegistryAuthState: vi.fn(),
  setRegistryAuth: vi.fn(),
  deleteRegistryAuth: vi.fn(),
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
        items: [{ ...sampleRecord, configuredSchemes: [] }],
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

const sampleAddedRecord = {
  ...sampleRecord,
  auth: {
    schemes: {
      apiKey: { type: "apiKey", in: "header", paramName: "X-Key" },
    },
    security: [{ apiKey: [] }],
  },
  resolvedClients: {},
};

describe("addRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds a registry from baseUrl alone", async () => {
    const res = makeRes();
    registriesService.addRegistry.mockResolvedValue(sampleAddedRecord);

    await addRegistry(
      makeReq({ body: { baseUrl: "  https://registry.example.com  " } }),
      cast(res),
    );

    expect(registriesService.addRegistry).toHaveBeenCalledWith(
      "https://registry.example.com",
      undefined,
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(sampleAddedRecord);
  });

  it("forwards an id override", async () => {
    const res = makeRes();
    registriesService.addRegistry.mockResolvedValue(sampleAddedRecord);

    await addRegistry(
      makeReq({
        body: { baseUrl: "https://registry.example.com", id: "  alias  " },
      }),
      cast(res),
    );

    expect(registriesService.addRegistry).toHaveBeenCalledWith(
      "https://registry.example.com",
      "alias",
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

const sampleAuthState = {
  schemes: {
    apiKey: { type: "apiKey", in: "header", paramName: "X-Key" },
    oauth2: {
      type: "oauth2",
      grantTypes: ["client_credentials"],
      tokenUrl: "https://registry.example.com/oauth/token",
      scopes: { read: "Read catalog" },
    },
  },
  security: [{ apiKey: [] }],
  credentials: [
    {
      id: "cred-1",
      kind: "registry",
      ownerId: "github",
      schemeName: "apiKey",
      schemeType: "apiKey",
      status: "active",
      oauthClientId: null,
      requestedScopes: [],
      grantedScopes: null,
      grantedSource: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      oauthClient: null,
    },
  ],
};

describe("getRegistryAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with schemes, security, and credentials", async () => {
    const res = makeRes();
    registriesService.getRegistryAuthState.mockResolvedValue(sampleAuthState);

    await getRegistryAuth(makeReq({ params: { id: "github" } }), cast(res));

    expect(registriesService.getRegistryAuthState).toHaveBeenCalledWith(
      "github",
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(sampleAuthState);
  });

  it("rejects a missing id", async () => {
    const res = makeRes();
    await expect(
      getRegistryAuth(makeReq({ params: {} }), cast(res)),
    ).rejects.toBeInstanceOf(HttpError);
  });
});

describe("setRegistryAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts apiKey material and returns 200", async () => {
    const res = makeRes();
    const body = { schemeName: "apiKey", type: "apiKey", apiKey: "secret" };
    const result = { auth: { credential: { id: "c1" }, status: "configured" } };
    registriesService.setRegistryAuth.mockResolvedValue(result);

    await setRegistryAuth(
      makeReq({ params: { id: "github" }, body }),
      cast(res),
    );

    expect(registriesService.setRegistryAuth).toHaveBeenCalledWith(
      "github",
      body,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(result);
  });

  it("accepts basic material", async () => {
    const res = makeRes();
    const body = {
      schemeName: "basic",
      type: "basic",
      username: "dev",
      password: "devpass",
    };
    registriesService.setRegistryAuth.mockResolvedValue({ auth: {} });

    await setRegistryAuth(
      makeReq({ params: { id: "github" }, body }),
      cast(res),
    );

    expect(registriesService.setRegistryAuth).toHaveBeenCalledWith(
      "github",
      body,
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("accepts bearer material", async () => {
    const res = makeRes();
    const body = { schemeName: "bearer", type: "bearer", token: "tok" };
    registriesService.setRegistryAuth.mockResolvedValue({ auth: {} });

    await setRegistryAuth(
      makeReq({ params: { id: "github" }, body }),
      cast(res),
    );

    expect(registriesService.setRegistryAuth).toHaveBeenCalledWith(
      "github",
      body,
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("accepts oauth2 client_credentials material with scopes", async () => {
    const res = makeRes();
    const body = {
      schemeName: "oauth2",
      type: "oauth2",
      grant: "client_credentials",
      clientId: "c",
      clientSecret: "s",
      scopes: ["read"],
    };
    registriesService.setRegistryAuth.mockResolvedValue({ auth: {} });

    await setRegistryAuth(
      makeReq({ params: { id: "github" }, body }),
      cast(res),
    );

    expect(registriesService.setRegistryAuth).toHaveBeenCalledWith(
      "github",
      body,
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("rejects a missing id", async () => {
    const res = makeRes();
    await expect(
      setRegistryAuth(
        makeReq({
          params: {},
          body: { schemeName: "apiKey", type: "apiKey", apiKey: "s" },
        }),
        cast(res),
      ),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it.each([
    { body: { type: "apiKey", apiKey: "s" }, why: "missing schemeName" },
    { body: { schemeName: "k", type: "apiKey" }, why: "missing apiKey" },
    {
      body: { schemeName: "b", type: "basic", username: "u" },
      why: "missing password",
    },
    { body: { schemeName: "b", type: "bearer" }, why: "missing token" },
    {
      body: { schemeName: "o", type: "oauth2", grant: "authorization_code" },
      why: "authorization_code grant",
    },
    {
      body: {
        schemeName: "o",
        type: "oauth2",
        grant: "client_credentials",
        clientId: "c",
      },
      why: "missing clientSecret",
    },
    {
      body: {
        schemeName: "o",
        type: "oauth2",
        grant: "client_credentials",
        clientId: "c",
        clientSecret: "s",
        scopes: "read",
      },
      why: "non-array scopes",
    },
    { body: { schemeName: "k", type: "weird" }, why: "unknown type" },
    { body: "not-an-object", why: "non-object body" },
  ])("rejects $why", async ({ body }) => {
    const res = makeRes();
    await expect(
      setRegistryAuth(makeReq({ params: { id: "github" }, body }), cast(res)),
    ).rejects.toBeInstanceOf(HttpError);
    expect(registriesService.setRegistryAuth).not.toHaveBeenCalled();
  });
});

describe("deleteRegistryAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates without a scheme and responds 204", async () => {
    const res = makeRes();
    await deleteRegistryAuth(makeReq({ params: { id: "github" } }), cast(res));
    expect(registriesService.deleteRegistryAuth).toHaveBeenCalledWith(
      "github",
      undefined,
    );
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("forwards a schemeName query param", async () => {
    const res = makeRes();
    await deleteRegistryAuth(
      makeReq({ params: { id: "github" }, query: { schemeName: "apiKey" } }),
      cast(res),
    );
    expect(registriesService.deleteRegistryAuth).toHaveBeenCalledWith(
      "github",
      "apiKey",
    );
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("rejects a blank schemeName", async () => {
    const res = makeRes();
    await expect(
      deleteRegistryAuth(
        makeReq({ params: { id: "github" }, query: { schemeName: "  " } }),
        cast(res),
      ),
    ).rejects.toBeInstanceOf(HttpError);
    expect(registriesService.deleteRegistryAuth).not.toHaveBeenCalled();
  });

  it("rejects a missing id", async () => {
    const res = makeRes();
    await expect(
      deleteRegistryAuth(makeReq({ params: {} }), cast(res)),
    ).rejects.toBeInstanceOf(HttpError);
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

    expect(registriesService.browseDefinitions).toHaveBeenCalledWith(
      "github",
      expect.objectContaining({ limit: 20 }),
    );
  });

  it.each([
    { query: { query: "" }, why: "empty query" },
    { query: { limit: "0" }, why: "zero limit" },
    { query: { limit: "abc" }, why: "non-numeric limit" },
  ])("rejects $why", async ({ query }) => {
    const res = makeRes();
    await expect(
      browseDefinitions(makeReq({ params: { id: "x" }, query }), cast(res)),
    ).rejects.toBeInstanceOf(HttpError);
    expect(registriesService.browseDefinitions).not.toHaveBeenCalled();
  });

  it("clamps a limit above the maximum instead of rejecting", async () => {
    const res = makeRes();
    registriesService.browseDefinitions.mockResolvedValue(samplePage);
    await browseDefinitions(
      makeReq({ params: { id: "x" }, query: { limit: "201" } }),
      cast(res),
    );
    expect(registriesService.browseDefinitions).toHaveBeenCalledWith(
      "x",
      expect.objectContaining({ limit: 100 }),
    );
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

    expect(registriesService.browseModules).toHaveBeenCalledWith(
      "github",
      expect.objectContaining({ type: "adapter", limit: 20 }),
    );
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
