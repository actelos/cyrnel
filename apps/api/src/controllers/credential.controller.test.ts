import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createOAuthClient,
  deleteOAuthClient,
  listOAuthClients,
  makeOwnerCredentialHandlers,
  oauthCallback,
  patchOAuthClient,
  resolveOAuthClients,
} from "@/controllers/credential.controller";
import { HttpError } from "@/models/error.model";

const createStore = () => ({
  listCredentials: vi.fn(),
  upsertApiKey: vi.fn(),
  upsertBasic: vi.fn(),
  upsertBearer: vi.fn(),
  upsertOAuth2: vi.fn(),
  disconnectScheme: vi.fn(),
  beginOAuth: vi.fn(),
  getForScheme: vi.fn(),
  completeOAuthCode: vi.fn(),
});

const createCredentialService = () => {
  const store = createStore();
  return {
    storeFor: vi.fn().mockReturnValue(store),
    toSummary: vi.fn(),
    listOAuthClients: vi.fn(),
    createOAuthClient: vi.fn(),
    patchOAuthClient: vi.fn(),
    deleteOAuthClient: vi.fn(),
    resolveOAuthClients: vi.fn(),
    completeOAuthAuthorization: vi.fn(),
  };
};

let credentialService: ReturnType<typeof createCredentialService>;
let store: ReturnType<typeof createStore>;

interface MockResponse {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

const makeRes = (): MockResponse => {
  const res = {} as MockResponse;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.end = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.set = vi.fn().mockReturnValue(res);
  return res;
};

const makeReq = (overrides: Record<string, unknown> = {}): Request =>
  ({
    app: { locals: { credentialService } },
    params: {},
    query: {},
    body: {},
    ...overrides,
  }) as unknown as Request;

const cast = (res: MockResponse) => res as unknown as Response;

const mockCredentialSummary = {
  id: "cred-1",
  schemeName: "apiKey",
  schemeType: "apiKey",
  ownerKind: "service" as const,
  ownerId: "svc-1",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  status: "active" as const,
};

describe("credential.controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    credentialService = createCredentialService();
    store = credentialService.storeFor();
  });

  describe("makeOwnerCredentialHandlers (service)", () => {
    const handlers = makeOwnerCredentialHandlers("service");

    it("listCredentials returns list without secrets", async () => {
      const res = makeRes();
      store.listCredentials.mockResolvedValue([mockCredentialSummary]);

      await handlers.listCredentials(
        makeReq({ params: { serviceId: "svc-1" } }),
        cast(res),
      );

      expect(credentialService.storeFor).toHaveBeenCalledWith(
        "service",
        "svc-1",
      );
      expect(store.listCredentials).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith([mockCredentialSummary]);
    });

    describe("upsertApiKey", () => {
      it("stores api key and returns summary with replaced flag", async () => {
        const res = makeRes();
        store.upsertApiKey.mockResolvedValue({
          credential: { id: "cred-1", schemeType: "apiKey" },
          replaced: false,
        });
        credentialService.toSummary.mockResolvedValue(mockCredentialSummary);

        await handlers.upsertApiKey(
          makeReq({
            params: { serviceId: "svc-1", schemeName: "apiKey" },
            body: { apiKey: "sk-test" },
          }),
          cast(res),
        );

        expect(credentialService.storeFor).toHaveBeenCalledWith(
          "service",
          "svc-1",
        );
        expect(store.upsertApiKey).toHaveBeenCalledWith("apiKey", "sk-test");
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({
          credential: mockCredentialSummary,
          replaced: false,
        });
      });

      it("trims scheme name and apiKey", async () => {
        const res = makeRes();
        store.upsertApiKey.mockResolvedValue({
          credential: { id: "cred-1" },
          replaced: false,
        });
        credentialService.toSummary.mockResolvedValue(mockCredentialSummary);

        await handlers.upsertApiKey(
          makeReq({
            params: { serviceId: "svc-1", schemeName: "  apiKey  " },
            body: { apiKey: "  sk-test  " },
          }),
          cast(res),
        );

        expect(store.upsertApiKey).toHaveBeenCalledWith("apiKey", "sk-test");
      });

      it("rejects empty schemeName", async () => {
        const res = makeRes();
        await expect(
          handlers.upsertApiKey(
            makeReq({
              params: { serviceId: "svc-1", schemeName: "" },
              body: { apiKey: "sk-test" },
            }),
            cast(res),
          ),
        ).rejects.toBeInstanceOf(HttpError);
      });

      it("rejects empty apiKey", async () => {
        const res = makeRes();
        await expect(
          handlers.upsertApiKey(
            makeReq({
              params: { serviceId: "svc-1", schemeName: "apiKey" },
              body: { apiKey: "" },
            }),
            cast(res),
          ),
        ).rejects.toBeInstanceOf(HttpError);
      });

      it("rejects non-object body", async () => {
        const res = makeRes();
        await expect(
          handlers.upsertApiKey(
            makeReq({
              params: { serviceId: "svc-1", schemeName: "apiKey" },
              body: "not-object",
            }),
            cast(res),
          ),
        ).rejects.toBeInstanceOf(HttpError);
      });
    });

    describe("upsertBasic", () => {
      it("stores basic auth and returns summary", async () => {
        const res = makeRes();
        store.upsertBasic.mockResolvedValue({
          credential: { id: "cred-1", schemeType: "basic" },
          replaced: false,
        });
        credentialService.toSummary.mockResolvedValue(mockCredentialSummary);

        await handlers.upsertBasic(
          makeReq({
            params: { serviceId: "svc-1", schemeName: "basic" },
            body: { username: "user", password: "pass" },
          }),
          cast(res),
        );

        expect(store.upsertBasic).toHaveBeenCalledWith("basic", "user", "pass");
        expect(res.status).toHaveBeenCalledWith(200);
      });

      it("rejects empty username or password", async () => {
        const res = makeRes();
        await expect(
          handlers.upsertBasic(
            makeReq({
              params: { serviceId: "svc-1", schemeName: "basic" },
              body: { username: "", password: "pass" },
            }),
            cast(res),
          ),
        ).rejects.toBeInstanceOf(HttpError);

        await expect(
          handlers.upsertBasic(
            makeReq({
              params: { serviceId: "svc-1", schemeName: "basic" },
              body: { username: "user", password: "" },
            }),
            cast(res),
          ),
        ).rejects.toBeInstanceOf(HttpError);
      });
    });

    describe("upsertBearer", () => {
      it("stores bearer token and returns summary", async () => {
        const res = makeRes();
        store.upsertBearer.mockResolvedValue({
          credential: { id: "cred-1", schemeType: "bearer" },
          replaced: false,
        });
        credentialService.toSummary.mockResolvedValue(mockCredentialSummary);

        await handlers.upsertBearer(
          makeReq({
            params: { serviceId: "svc-1", schemeName: "bearer" },
            body: { token: "tok-123" },
          }),
          cast(res),
        );

        expect(store.upsertBearer).toHaveBeenCalledWith("bearer", "tok-123");
        expect(res.status).toHaveBeenCalledWith(200);
      });

      it("rejects empty token", async () => {
        const res = makeRes();
        await expect(
          handlers.upsertBearer(
            makeReq({
              params: { serviceId: "svc-1", schemeName: "bearer" },
              body: { token: "" },
            }),
            cast(res),
          ),
        ).rejects.toBeInstanceOf(HttpError);
      });
    });

    describe("upsertOAuth2", () => {
      it("stores oauth2 credential and returns summary", async () => {
        const res = makeRes();
        store.upsertOAuth2.mockResolvedValue({
          credential: { id: "cred-1", schemeType: "oauth2" },
          replaced: false,
          unknownScopes: [],
        });
        credentialService.toSummary.mockResolvedValue(mockCredentialSummary);

        await handlers.upsertOAuth2(
          makeReq({
            params: { serviceId: "svc-1", schemeName: "oauth2" },
            body: { oauthClientId: "client-1", scopes: ["read"] },
          }),
          cast(res),
        );

        expect(store.upsertOAuth2).toHaveBeenCalledWith("oauth2", "client-1", [
          "read",
        ]);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({
          credential: mockCredentialSummary,
          replaced: false,
        });
      });

      it("includes warning for unknown scopes", async () => {
        const res = makeRes();
        store.upsertOAuth2.mockResolvedValue({
          credential: { id: "cred-1" },
          replaced: false,
          unknownScopes: ["admin"],
        });
        credentialService.toSummary.mockResolvedValue(mockCredentialSummary);

        await handlers.upsertOAuth2(
          makeReq({
            params: { serviceId: "svc-1", schemeName: "oauth2" },
            body: { oauthClientId: "client-1", scopes: ["read", "admin"] },
          }),
          cast(res),
        );

        const response = res.json.mock.calls[0][0];
        expect(response.warning).toBeDefined();
        expect(response.warning.unknownScopes).toEqual(["admin"]);
      });

      it("rejects empty oauthClientId", async () => {
        const res = makeRes();
        await expect(
          handlers.upsertOAuth2(
            makeReq({
              params: { serviceId: "svc-1", schemeName: "oauth2" },
              body: { oauthClientId: "", scopes: [] },
            }),
            cast(res),
          ),
        ).rejects.toBeInstanceOf(HttpError);
      });

      it("defaults scopes to empty array", async () => {
        const res = makeRes();
        store.upsertOAuth2.mockResolvedValue({
          credential: { id: "cred-1" },
          replaced: false,
          unknownScopes: [],
        });
        credentialService.toSummary.mockResolvedValue(mockCredentialSummary);

        await handlers.upsertOAuth2(
          makeReq({
            params: { serviceId: "svc-1", schemeName: "oauth2" },
            body: { oauthClientId: "client-1" },
          }),
          cast(res),
        );

        expect(store.upsertOAuth2).toHaveBeenCalledWith(
          "oauth2",
          "client-1",
          [],
        );
      });
    });

    describe("disconnectScheme", () => {
      it("removes scheme and returns 204", async () => {
        const res = makeRes();
        store.disconnectScheme.mockResolvedValue(true);

        await handlers.disconnectScheme(
          makeReq({ params: { serviceId: "svc-1", schemeName: "apiKey" } }),
          cast(res),
        );

        expect(store.disconnectScheme).toHaveBeenCalledWith("apiKey");
        expect(res.status).toHaveBeenCalledWith(204);
        expect(res.send).toHaveBeenCalled();
      });

      it("throws 404 when scheme not configured", async () => {
        const res = makeRes();
        store.disconnectScheme.mockResolvedValue(false);

        await expect(
          handlers.disconnectScheme(
            makeReq({
              params: { serviceId: "svc-1", schemeName: "nonexistent" },
            }),
            cast(res),
          ),
        ).rejects.toMatchObject({
          statusCode: 404,
          message: "No credential configured for scheme 'nonexistent'.",
        });
      });
    });

    describe("beginOAuthAuthorization", () => {
      it("starts oauth flow and returns authorization URL", async () => {
        const res = makeRes();
        store.beginOAuth.mockResolvedValue({
          authorizationUrl: "https://provider.com/auth?state=xyz",
          state: "xyz",
        });

        await handlers.beginOAuthAuthorization(
          makeReq({ params: { serviceId: "svc-1", schemeName: "oauth2" } }),
          cast(res),
        );

        expect(store.beginOAuth).toHaveBeenCalledWith("oauth2");
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({
          authorizationUrl: "https://provider.com/auth?state=xyz",
          state: "xyz",
        });
      });
    });

    describe("submitOAuthCode", () => {
      it("completes oauth code exchange", async () => {
        const res = makeRes();
        store.getForScheme.mockResolvedValue({ id: "cred-1" });
        store.completeOAuthCode.mockResolvedValue(undefined);

        await handlers.submitOAuthCode(
          makeReq({
            params: { serviceId: "svc-1", schemeName: "oauth2" },
            body: { code: "auth-code", state: "xyz" },
          }),
          cast(res),
        );

        expect(store.getForScheme).toHaveBeenCalledWith("oauth2");
        expect(store.completeOAuthCode).toHaveBeenCalledWith(
          "cred-1",
          "auth-code",
          "xyz",
        );
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ credentialId: "cred-1" });
      });

      it("treats empty state as undefined", async () => {
        const res = makeRes();
        store.getForScheme.mockResolvedValue({ id: "cred-1" });
        store.completeOAuthCode.mockResolvedValue(undefined);

        await handlers.submitOAuthCode(
          makeReq({
            params: { serviceId: "svc-1", schemeName: "oauth2" },
            body: { code: "auth-code", state: "" },
          }),
          cast(res),
        );

        expect(store.completeOAuthCode).toHaveBeenCalledWith(
          "cred-1",
          "auth-code",
          undefined,
        );
      });

      it("throws 404 when no credential for scheme", async () => {
        const res = makeRes();
        store.getForScheme.mockResolvedValue(null);

        await expect(
          handlers.submitOAuthCode(
            makeReq({
              params: { serviceId: "svc-1", schemeName: "oauth2" },
              body: { code: "auth-code" },
            }),
            cast(res),
          ),
        ).rejects.toMatchObject({
          statusCode: 404,
          message: "No credential configured for scheme 'oauth2'.",
        });
      });
    });
  });

  describe("makeOwnerCredentialHandlers (module)", () => {
    const handlers = makeOwnerCredentialHandlers("module");

    it("uses moduleId for owner lookup", async () => {
      const res = makeRes();
      store.listCredentials.mockResolvedValue([]);

      await handlers.listCredentials(
        makeReq({ params: { moduleId: "mod-1" } }),
        cast(res),
      );

      expect(credentialService.storeFor).toHaveBeenCalledWith(
        "module",
        "mod-1",
      );
    });
  });

  describe("OAuth Client handlers", () => {
    describe("listOAuthClients", () => {
      it("returns list of clients", async () => {
        const res = makeRes();
        credentialService.listOAuthClients.mockResolvedValue([
          { id: "c1", provider: "p1" },
        ]);

        await listOAuthClients(makeReq(), cast(res));

        expect(credentialService.listOAuthClients).toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith([{ id: "c1", provider: "p1" }]);
      });
    });

    describe("createOAuthClient", () => {
      it("creates client and returns 201 with clientId", async () => {
        const res = makeRes();
        credentialService.createOAuthClient.mockResolvedValue("new-client-id");

        await createOAuthClient(
          makeReq({
            body: {
              provider: "test",
              clientId: "client-1",
              clientSecret: "secret",
              tokenUrl: "https://provider.com/token",
              authorizationUrl: "https://provider.com/authorize",
              availableScopes: ["read"],
            },
          }),
          cast(res),
        );

        expect(credentialService.createOAuthClient).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(201);
        expect(res.json).toHaveBeenCalledWith({ id: "new-client-id" });
      });

      it("requires provider, clientId, clientSecret, tokenUrl, availableScopes", async () => {
        const res = makeRes();
        await expect(
          createOAuthClient(makeReq({ body: { provider: "test" } }), cast(res)),
        ).rejects.toBeInstanceOf(HttpError);
      });

      it("validates http URLs for tokenUrl and authorizationUrl", async () => {
        const res = makeRes();
        await expect(
          createOAuthClient(
            makeReq({
              body: {
                provider: "test",
                clientId: "client-1",
                clientSecret: "secret",
                tokenUrl: "not-a-url",
                availableScopes: ["read"],
              },
            }),
            cast(res),
          ),
        ).rejects.toBeInstanceOf(HttpError);
      });

      it("validates redirectUris are http URLs", async () => {
        const res = makeRes();
        await expect(
          createOAuthClient(
            makeReq({
              body: {
                provider: "test",
                clientId: "client-1",
                clientSecret: "secret",
                tokenUrl: "https://provider.com/token",
                redirectUris: ["not-a-url"],
                availableScopes: ["read"],
              },
            }),
            cast(res),
          ),
        ).rejects.toBeInstanceOf(HttpError);
      });
    });

    describe("patchOAuthClient", () => {
      it("patches client and returns updated client", async () => {
        const res = makeRes();
        credentialService.patchOAuthClient.mockResolvedValue({
          id: "c1",
          provider: "updated",
        });

        await patchOAuthClient(
          makeReq({
            params: { id: "c1" },
            body: { provider: "updated" },
          }),
          cast(res),
        );

        expect(credentialService.patchOAuthClient).toHaveBeenCalledWith("c1", {
          provider: "updated",
        });
        expect(res.json).toHaveBeenCalledWith({
          id: "c1",
          provider: "updated",
        });
      });

      it("rejects empty id", async () => {
        const res = makeRes();
        await expect(
          patchOAuthClient(
            makeReq({ params: { id: "" }, body: { provider: "test" } }),
            cast(res),
          ),
        ).rejects.toBeInstanceOf(HttpError);
      });

      it("requires at least one field to update", async () => {
        const res = makeRes();
        await expect(
          patchOAuthClient(
            makeReq({ params: { id: "c1" }, body: {} }),
            cast(res),
          ),
        ).rejects.toBeInstanceOf(HttpError);
      });
    });

    describe("deleteOAuthClient", () => {
      it("deletes client and returns 204", async () => {
        const res = makeRes();
        credentialService.deleteOAuthClient.mockResolvedValue(undefined);

        await deleteOAuthClient(makeReq({ params: { id: "c1" } }), cast(res));

        expect(credentialService.deleteOAuthClient).toHaveBeenCalledWith("c1");
        expect(res.status).toHaveBeenCalledWith(204);
        expect(res.send).toHaveBeenCalled();
      });

      it("rejects empty id", async () => {
        const res = makeRes();
        await expect(
          deleteOAuthClient(makeReq({ params: { id: "" } }), cast(res)),
        ).rejects.toBeInstanceOf(HttpError);
      });
    });

    describe("resolveOAuthClients", () => {
      it("resolves clients by authorization URL and scopes", async () => {
        const res = makeRes();
        credentialService.resolveOAuthClients.mockResolvedValue([
          { clientId: "c1", scopeCompatible: true },
        ]);

        await resolveOAuthClients(
          makeReq({
            query: {
              authorizationUrl: "https://provider.com/authorize",
              scopes: "read write",
            },
          }),
          cast(res),
        );

        expect(credentialService.resolveOAuthClients).toHaveBeenCalledWith({
          authorizationUrl: "https://provider.com/authorize",
          requestedScopes: ["read", "write"],
        });
        expect(res.json).toHaveBeenCalledWith({
          clients: [{ clientId: "c1", scopeCompatible: true }],
        });
      });

      it("parses scopes from comma/space separated string", async () => {
        const res = makeRes();
        credentialService.resolveOAuthClients.mockResolvedValue([]);

        await resolveOAuthClients(
          makeReq({
            query: { authorizationUrl: "https://p.com/a", scopes: "a, b ,c" },
          }),
          cast(res),
        );

        expect(credentialService.resolveOAuthClients).toHaveBeenCalledWith({
          authorizationUrl: "https://p.com/a",
          requestedScopes: ["a", "b", "c"],
        });
      });

      it("rejects missing authorizationUrl", async () => {
        const res = makeRes();
        await expect(
          resolveOAuthClients(makeReq({ query: {} }), cast(res)),
        ).rejects.toBeInstanceOf(HttpError);
      });
    });

    describe("oauthCallback", () => {
      it("completes authorization and returns credentialId", async () => {
        const res = makeRes();
        credentialService.completeOAuthAuthorization.mockResolvedValue({
          id: "cred-1",
        });

        await oauthCallback(
          makeReq({ query: { code: "auth-code", state: "xyz" } }),
          cast(res),
        );

        expect(
          credentialService.completeOAuthAuthorization,
        ).toHaveBeenCalledWith("xyz", "auth-code");
        expect(res.json).toHaveBeenCalledWith({
          ok: true,
          credentialId: "cred-1",
        });
      });

      it("rejects missing code or state", async () => {
        const res = makeRes();
        await expect(
          oauthCallback(makeReq({ query: { code: "c" } }), cast(res)),
        ).rejects.toBeInstanceOf(HttpError);
        await expect(
          oauthCallback(makeReq({ query: { state: "s" } }), cast(res)),
        ).rejects.toBeInstanceOf(HttpError);
      });
    });
  });
});
