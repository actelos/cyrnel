import type {
  ConfigProvider,
  CredentialProvider,
  ModuleLogBindings,
  ModuleLogger,
  ResolvedCredential,
  SecretsProvider,
} from "@cyrnel/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRequest } from "./client";

vi.mock("./client", async (importOriginal) => {
  const original = await importOriginal<typeof import("./client")>();
  return {
    ...original,
    makeRequest: vi.fn(),
  };
});

import oapi from "@/index";

function configProvider(
  values: Record<string, unknown>,
): ConfigProvider<Record<string, unknown>> {
  return {
    get: async (key: string) => {
      if (key in values) return values[key];
      const err = new Error(`Key '${String(key)}' is not configured`);
      err.name = "ProviderKeyNotConfigured";
      throw err;
    },
  };
}

function secretsProvider(): SecretsProvider {
  return {
    get: async () => {
      throw new Error("no secrets declared");
    },
  };
}

function credentialProvider(
  credentials: Record<string, ResolvedCredential>,
): CredentialProvider {
  return {
    getCredential: async (schemeName: string) => {
      const credential = credentials[schemeName];
      if (!credential) throw new Error(`no credential for ${schemeName}`);
      return credential;
    },
  };
}

describe("openapi module default export", () => {
  it("has configSchema and canonical empty secretsSchema", () => {
    expect(oapi.configSchema).toMatchObject({
      type: "object",
      properties: { defaultTimeoutMs: { type: "integer" } },
      additionalProperties: false,
    });
    expect(oapi.secretsSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("instantiates an adapter that accepts the new setup context", async () => {
    const adapter = oapi.instantiate();
    const mockLogger: ModuleLogger<ModuleLogBindings> = {
      context: {},
      child: <Next extends ModuleLogBindings>(
        bindings: Next,
      ): ModuleLogger<ModuleLogBindings & Next> =>
        ({
          ...mockLogger,
          context: { ...mockLogger.context, ...bindings },
        }) as ModuleLogger<ModuleLogBindings & Next>,
      redact: () => mockLogger,
      isLevelEnabled: () => true,
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    };
    await expect(
      adapter.setup({
        config: configProvider({}),
        secrets: secretsProvider(),
        logger: mockLogger,
      }),
    ).resolves.toBeUndefined();
    await adapter.teardown();
  });
});

describe("OpenapiAdapter invoke", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(makeRequest).mockClear();
  });

  const makeMockServiceState = () => ({
    id: "petstore",
    config: configProvider({ timeoutMs: 5000 }),
    secrets: secretsProvider(),
    schemes: {
      ApiKey: { type: "apiKey", in: "header", paramName: "X-API-Key" },
    },
    security: [{ ApiKey: [] }],
    credentials: credentialProvider({
      ApiKey: { type: "apiKey", value: "my-key" },
    }),
    adapterDomain: {
      servers: [{ url: "https://api.example.com" }],
      securitySchemes: {
        ApiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
    },
    tools: {
      getPet: {
        security: [{ ApiKey: [] }],
        adapterDomain: {
          path: "/pets/{petId}",
          method: "get",
          security: [{ ApiKey: [] }],
        },
      },
      createPet: {
        security: [{ ApiKey: [] }],
        adapterDomain: {
          path: "/pets",
          method: "post",
          security: [{ ApiKey: [] }],
        },
      },
      noAuth: {
        security: [],
        adapterDomain: {
          path: "/health",
          method: "get",
          security: [],
        },
      },
    },
  });

  // biome-ignore lint/suspicious/noExplicitAny: test helper to hydrate state directly
  function hydrate(adapter: any, id: string, state: unknown) {
    adapter.services.set(id, state);
  }

  function makeAdapter() {
    const adapter = oapi.instantiate();
    hydrate(adapter, "petstore", makeMockServiceState());
    return adapter;
  }

  it("makes a GET request with path params and auth", async () => {
    const requestMock = vi.mocked(makeRequest);
    requestMock.mockResolvedValue({
      status: "200",
      body: { id: "123", name: "Fluffy" },
    });

    const adapter = makeAdapter();
    const result = await adapter.invoke({
      serviceId: "petstore",
      toolId: "getPet",
      parameters: { path: { petId: "123" } },
    });

    expect(result).toEqual({
      status: "200",
      body: { id: "123", name: "Fluffy" },
    });

    const callArgs = requestMock.mock.calls[0][0];
    expect(callArgs.url).toBe("https://api.example.com/pets/123");
    expect(callArgs.method).toBe("get");
    expect(callArgs.headers).toMatchObject({
      "X-API-Key": "my-key",
    });
  });

  it("makes a POST request with JSON body", async () => {
    const requestMock = vi.mocked(makeRequest);
    requestMock.mockResolvedValue({
      status: "201",
      body: { id: "456" },
    });

    const adapter = makeAdapter();
    const result = await adapter.invoke({
      serviceId: "petstore",
      toolId: "createPet",
      parameters: { body: { name: "Buddy", species: "dog" } },
    });

    expect(result).toEqual({ status: "201", body: { id: "456" } });

    const callArgs = requestMock.mock.calls[0][0];
    expect(callArgs.url).toBe("https://api.example.com/pets");
    expect(callArgs.method).toBe("post");
    expect(callArgs.body).toEqual({ name: "Buddy", species: "dog" });
  });

  it("includes query params in the URL", async () => {
    const requestMock = vi.mocked(makeRequest);
    requestMock.mockResolvedValue({ status: "200", body: [] });

    const adapter = oapi.instantiate();
    const state = makeMockServiceState();
    hydrate(adapter, "petstore", {
      ...state,
      tools: {
        listPets: {
          adapterDomain: {
            path: "/pets",
            method: "get",
            security: [{ ApiKey: [] }],
          },
        },
      },
    });

    await adapter.invoke({
      serviceId: "petstore",
      toolId: "listPets",
      parameters: { query: { limit: "10", status: "available" } },
    });

    const callArgs = requestMock.mock.calls[0][0];
    expect(callArgs.url).toBe(
      "https://api.example.com/pets?limit=10&status=available",
    );
  });

  it("includes cookie params as Cookie header", async () => {
    const requestMock = vi.mocked(makeRequest);
    requestMock.mockResolvedValue({ status: "200", body: {} });

    const adapter = oapi.instantiate();
    const state = makeMockServiceState();
    hydrate(adapter, "petstore", {
      ...state,
      tools: {
        checkSession: {
          adapterDomain: {
            path: "/session",
            method: "get",
            security: [],
          },
        },
      },
    });

    await adapter.invoke({
      serviceId: "petstore",
      toolId: "checkSession",
      parameters: { cookies: { sessionId: "abc123" } },
    });

    const callArgs = requestMock.mock.calls[0][0];
    expect(callArgs.headers).toMatchObject({
      Cookie: "sessionId=abc123",
    });
  });

  it("throws when service is not hydrated", async () => {
    const adapter = makeAdapter();

    await expect(
      adapter.invoke({
        serviceId: "nonexistent",
        toolId: "getPet",
        parameters: {},
      }),
    ).rejects.toThrow("Service 'nonexistent' is not hydrated");
  });

  it("throws when tool is not found", async () => {
    const adapter = makeAdapter();

    await expect(
      adapter.invoke({
        serviceId: "petstore",
        toolId: "unknownTool",
        parameters: {},
      }),
    ).rejects.toThrow("Tool 'unknownTool' not found in service 'petstore'.");
  });

  it("preserves versioned server URLs", async () => {
    const requestMock = vi.mocked(makeRequest);
    requestMock.mockResolvedValue({ status: "200", body: {} });

    const adapter = oapi.instantiate();
    const state = makeMockServiceState();
    hydrate(adapter, "petstore", {
      ...state,
      adapterDomain: {
        ...state.adapterDomain,
        servers: [{ url: "https://api.example.com/api/v1" }],
      },
    });

    await adapter.invoke({
      serviceId: "petstore",
      toolId: "getPet",
      parameters: { path: { petId: "123" } },
    });

    const callArgs = requestMock.mock.calls[0][0];
    expect(callArgs.url).toBe("https://api.example.com/api/v1/pets/123");
  });

  it("resolves auth through the host credential provider", async () => {
    const requestMock = vi.mocked(makeRequest);
    requestMock.mockResolvedValue({ status: "200", body: {} });

    const provider = credentialProvider({
      ApiKey: { type: "apiKey", value: "conn-key" },
    });

    const adapter = oapi.instantiate();
    await adapter.hydrateService({
      id: "petstore",
      config: configProvider({ timeoutMs: 5000 }),
      secrets: secretsProvider(),
      schemes: {
        ApiKey: { type: "apiKey", in: "header", paramName: "X-API-Key" },
      },
      security: [{ ApiKey: [] }],
      credentials: provider,
      adapterDomain: {
        servers: [{ url: "https://api.example.com" }],
      },
      tools: {
        getPet: {
          security: [{ ApiKey: [] }],
          adapterDomain: {
            path: "/pets/{petId}",
            method: "get",
            security: [{ ApiKey: [] }],
          },
        },
      },
    });

    await adapter.invoke({
      serviceId: "petstore",
      toolId: "getPet",
      parameters: { path: { petId: "123" } },
    });

    const callArgs = requestMock.mock.calls[0][0];
    expect(callArgs.headers).toMatchObject({ "X-API-Key": "conn-key" });
  });

  it("places provider-resolved query auth into the URL", async () => {
    const requestMock = vi.mocked(makeRequest);
    requestMock.mockResolvedValue({ status: "200", body: {} });

    const adapter = oapi.instantiate();
    await adapter.hydrateService({
      id: "petstore",
      config: configProvider({}),
      secrets: secretsProvider(),
      schemes: {
        QueryKey: { type: "apiKey", in: "query", paramName: "key" },
      },
      security: [{ QueryKey: [] }],
      credentials: credentialProvider({
        QueryKey: { type: "apiKey", value: "q" },
      }),
      adapterDomain: {
        servers: [{ url: "https://api.example.com" }],
      },
      tools: {
        search: {
          security: [{ QueryKey: [] }],
          adapterDomain: {
            path: "/search",
            method: "get",
            security: [{ QueryKey: [] }],
          },
        },
      },
    });

    await adapter.invoke({
      serviceId: "petstore",
      toolId: "search",
      parameters: {},
    });

    const callArgs = requestMock.mock.calls[0][0];
    expect(callArgs.url).toBe("https://api.example.com/search?key=q");
  });

  it("places http bearer auth into the Authorization header", async () => {
    const requestMock = vi.mocked(makeRequest);
    requestMock.mockResolvedValue({ status: "200", body: {} });

    const adapter = oapi.instantiate();
    await adapter.hydrateService({
      id: "petstore",
      config: configProvider({}),
      secrets: secretsProvider(),
      schemes: {
        Bearer: { type: "http", scheme: "bearer" },
      },
      security: [{ Bearer: [] }],
      credentials: credentialProvider({
        Bearer: { type: "bearer", token: "tok" },
      }),
      adapterDomain: {
        servers: [{ url: "https://api.example.com" }],
      },
      tools: {
        me: {
          security: [{ Bearer: [] }],
          adapterDomain: {
            path: "/me",
            method: "get",
            security: [{ Bearer: [] }],
          },
        },
      },
    });

    await adapter.invoke({
      serviceId: "petstore",
      toolId: "me",
      parameters: {},
    });

    const callArgs = requestMock.mock.calls[0][0];
    expect(callArgs.headers).toMatchObject({
      Authorization: "Bearer tok",
    });
  });

  it("throws when declared auth has no credential provider", async () => {
    const adapter = oapi.instantiate();
    await adapter.hydrateService({
      id: "petstore",
      config: configProvider({}),
      secrets: secretsProvider(),
      schemes: {
        ApiKey: { type: "apiKey", in: "header", paramName: "X-API-Key" },
      },
      security: [{ ApiKey: [] }],
      adapterDomain: {
        servers: [{ url: "https://api.example.com" }],
      },
      tools: {
        getPet: {
          security: [{ ApiKey: [] }],
          adapterDomain: {
            path: "/pets",
            method: "get",
            security: [{ ApiKey: [] }],
          },
        },
      },
    });

    await expect(
      adapter.invoke({
        serviceId: "petstore",
        toolId: "getPet",
        parameters: {},
      }),
    ).rejects.toThrow("No credential provider is available");
  });

  it("propagates credential errors without falling back to secrets", async () => {
    const requestMock = vi.mocked(makeRequest);
    requestMock.mockResolvedValue({ status: "200", body: {} });

    const adapter = oapi.instantiate();
    await adapter.hydrateService({
      id: "petstore",
      config: configProvider({}),
      secrets: secretsProvider(),
      schemes: {
        ApiKey: { type: "apiKey", in: "header", paramName: "X-API-Key" },
      },
      security: [{ ApiKey: [] }],
      credentials: {
        getCredential: async (schemeName: string) => {
          throw new Error(`no credential for ${schemeName}`);
        },
      },
      adapterDomain: {
        servers: [{ url: "https://api.example.com" }],
      },
      tools: {
        getPet: {
          security: [{ ApiKey: [] }],
          adapterDomain: {
            path: "/pets",
            method: "get",
            security: [{ ApiKey: [] }],
          },
        },
      },
    });

    await expect(
      adapter.invoke({
        serviceId: "petstore",
        toolId: "getPet",
        parameters: {},
      }),
    ).rejects.toThrow("no credential for ApiKey");
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("fails closed when security references an unsupported scheme", async () => {
    const requestMock = vi.mocked(makeRequest);
    requestMock.mockResolvedValue({ status: "200", body: {} });

    const adapter = oapi.instantiate();
    await adapter.hydrateService({
      id: "petstore",
      config: configProvider({}),
      secrets: secretsProvider(),
      schemes: {},
      security: [{ DigestAuth: [] }],
      credentials: credentialProvider({}),
      adapterDomain: {
        servers: [{ url: "https://api.example.com" }],
        securitySchemes: {
          DigestAuth: { type: "http", scheme: "digest" },
        },
      },
      tools: {
        getPet: {
          security: [{ DigestAuth: [] }],
          adapterDomain: {
            path: "/pets",
            method: "get",
            security: [{ DigestAuth: [] }],
          },
        },
      },
    });

    await expect(
      adapter.invoke({
        serviceId: "petstore",
        toolId: "getPet",
        parameters: {},
      }),
    ).rejects.toThrow("No auth scheme 'DigestAuth' declared");
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("fails closed after falling through all OR groups", async () => {
    const requestMock = vi.mocked(makeRequest);
    requestMock.mockResolvedValue({ status: "200", body: {} });

    const adapter = oapi.instantiate();
    await adapter.hydrateService({
      id: "petstore",
      config: configProvider({}),
      secrets: secretsProvider(),
      schemes: {
        ApiKey: { type: "apiKey", in: "header", paramName: "X-API-Key" },
        QueryKey: { type: "apiKey", in: "query", paramName: "key" },
      },
      security: [{ ApiKey: [] }, { QueryKey: [] }],
      credentials: credentialProvider({}),
      adapterDomain: {
        servers: [{ url: "https://api.example.com" }],
      },
      tools: {
        getPet: {
          security: [{ ApiKey: [] }, { QueryKey: [] }],
          adapterDomain: {
            path: "/pets",
            method: "get",
            security: [{ ApiKey: [] }, { QueryKey: [] }],
          },
        },
      },
    });

    await expect(
      adapter.invoke({
        serviceId: "petstore",
        toolId: "getPet",
        parameters: {},
      }),
    ).rejects.toThrow("no credential for QueryKey");
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("handles 204 no-content response", async () => {
    const requestMock = vi.mocked(makeRequest);
    requestMock.mockResolvedValue({ status: "204" });

    const adapter = oapi.instantiate();
    const state = makeMockServiceState();
    hydrate(adapter, "petstore", {
      ...state,
      tools: {
        deletePet: {
          adapterDomain: {
            path: "/pets/{petId}",
            method: "delete",
            security: [{ ApiKey: [] }],
          },
        },
      },
    });

    const result = await adapter.invoke({
      serviceId: "petstore",
      toolId: "deletePet",
      parameters: { path: { petId: "123" } },
    });

    expect(result).toEqual({ status: "204" });
  });
});
