import { afterEach, describe, expect, it, vi } from "vitest";

import { instantiate, manifest } from "@/index";

describe("openapi module manifest", () => {
  it("uses id as the stable identifier and name as the display label", () => {
    expect(manifest).toMatchObject({
      id: "openapi",
      name: "OpenAPI Adapter",
      type: "adapter",
    });
  });

  it("declares the supported configSchema", () => {
    expect(manifest.configSchema).toMatchObject({
      type: "object",
      properties: { defaultTimeoutMs: { type: "integer" } },
      additionalProperties: false,
    });
  });

  it("declares the supported secretsSchema", () => {
    expect(manifest.secretsSchema).toEqual({ type: "null" });
  });

  it("instantiates an adapter that accepts the new setup context", async () => {
    const adapter = instantiate();
    await expect(
      adapter.setup({ config: {}, secrets: {} }),
    ).resolves.toBeUndefined();
    await adapter.teardown();
  });
});

describe("OpenapiAdapter invoke", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockServiceState = {
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
  };

  // biome-ignore lint/suspicious/noExplicitAny: test helper to hydrate state directly
  function hydrate(adapter: any, id: string, state: unknown) {
    adapter.services.set(id, state);
  }

  function makeAdapter() {
    const adapter = instantiate();
    hydrate(adapter, "petstore", mockServiceState);
    return adapter;
  }

  it("makes a GET request with path params and auth", async () => {
    const mockResponse = new Response(
      JSON.stringify({ id: "123", name: "Fluffy" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const fetchMock = vi.fn().mockResolvedValue(mockResponse);
    vi.stubGlobal("fetch", fetchMock);

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

    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[0]).toBe("https://api.example.com/pets/123");
    expect(callArgs[1].method).toBe("GET");
    expect(callArgs[1].headers).toMatchObject({
      "X-API-Key": "my-key",
      accept: "application/json",
    });
  });

  it("makes a POST request with JSON body", async () => {
    const mockResponse = new Response(JSON.stringify({ id: "456" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
    const fetchMock = vi.fn().mockResolvedValue(mockResponse);
    vi.stubGlobal("fetch", fetchMock);

    const adapter = makeAdapter();
    const result = await adapter.invoke({
      serviceId: "petstore",
      toolId: "createPet",
      parameters: { body: { name: "Buddy", species: "dog" } },
    });

    expect(result).toEqual({ status: "201", body: { id: "456" } });

    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[0]).toBe("https://api.example.com/pets");
    expect(callArgs[1].method).toBe("POST");
    expect(callArgs[1].body).toBe(
      JSON.stringify({ name: "Buddy", species: "dog" }),
    );
  });

  it("includes query params in the URL", async () => {
    const mockResponse = new Response(
      JSON.stringify([{ id: "1" }, { id: "2" }]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const fetchMock = vi.fn().mockResolvedValue(mockResponse);
    vi.stubGlobal("fetch", fetchMock);

    // Create a custom adapter for this test with listPets tool
    const adapter = instantiate();
    const listPetsState = {
      ...mockServiceState,
      tools: {
        listPets: {
          adapterDomain: {
            path: "/pets",
            method: "get",
            security: [{ ApiKey: [] }],
          },
        },
      },
    };
    hydrate(adapter, "petstore", listPetsState);

    await adapter.invoke({
      serviceId: "petstore",
      toolId: "listPets",
      parameters: { query: { limit: "10", status: "available" } },
    });

    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[0]).toBe(
      "https://api.example.com/pets?limit=10&status=available",
    );
  });

  it("includes cookie params as Cookie header", async () => {
    const mockResponse = new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const fetchMock = vi.fn().mockResolvedValue(mockResponse);
    vi.stubGlobal("fetch", fetchMock);

    const adapter = instantiate();
    const cookieState = {
      ...mockServiceState,
      tools: {
        checkSession: {
          adapterDomain: {
            path: "/session",
            method: "get",
            security: [],
          },
        },
      },
    };
    hydrate(adapter, "petstore", cookieState);

    await adapter.invoke({
      serviceId: "petstore",
      toolId: "checkSession",
      parameters: { cookies: { sessionId: "abc123" } },
    });

    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[1].headers).toMatchObject({
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
    const mockResponse = new Response(null, {
      status: 204,
      headers: { "content-type": "application/json" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const adapter = instantiate();
    const deleteState = {
      ...mockServiceState,
      tools: {
        deletePet: {
          adapterDomain: {
            path: "/pets/{petId}",
            method: "delete",
            security: [{ ApiKey: [] }],
          },
        },
      },
    };
    hydrate(adapter, "petstore", deleteState);

    const result = await adapter.invoke({
      serviceId: "petstore",
      toolId: "deletePet",
      parameters: { path: { petId: "123" } },
    });

    expect(result).toEqual({ status: "204" });
  });
});
