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

describe("openapi module default export", () => {
  it("has configSchema and secretsSchema", () => {
    expect(oapi.configSchema).toMatchObject({
      type: "object",
      properties: { defaultTimeoutMs: { type: "integer" } },
      additionalProperties: false,
    });
    expect(oapi.secretsSchema).toEqual({ type: "null" });
  });

  it("instantiates an adapter that accepts the new setup context", async () => {
    const adapter = oapi.instantiate();
    await expect(
      adapter.setup({ config: {}, secrets: {} }),
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
    config: { timeoutMs: 5000 },
    secrets: { ApiKey: "my-key" },
    adapterDomain: {
      servers: [{ url: "https://api.example.com" }],
      securitySchemes: {
        ApiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
    },
    tools: {
      getPet: {
        adapterDomain: {
          path: "/pets/{petId}",
          method: "get",
          security: [{ ApiKey: [] }],
        },
      },
      createPet: {
        adapterDomain: {
          path: "/pets",
          method: "post",
          security: [{ ApiKey: [] }],
        },
      },
      noAuth: {
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
