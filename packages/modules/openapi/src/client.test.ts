import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAuthHeaders,
  buildQueryString,
  makeRequest,
  resolveServerUrl,
  substitutePathParams,
} from "./client";

describe("resolveServerUrl", () => {
  it("uses serverUrl override from config when present", () => {
    const result = resolveServerUrl([{ url: "https://api.example.com/v1" }], {
      serverUrl: "https://custom.example.com",
    });
    expect(result).toBe("https://custom.example.com");
  });

  it("uses first server url when no override", () => {
    const result = resolveServerUrl(
      [{ url: "https://api.example.com/v1" }],
      {},
    );
    expect(result).toBe("https://api.example.com/v1");
  });

  it("substitutes server variables from config", () => {
    const result = resolveServerUrl(
      [
        {
          url: "https://{environment}.example.com/{version}",
          variables: {
            environment: { default: "api" },
            version: { default: "v2" },
          },
        },
      ],
      { serverVar_environment: "staging", serverVar_version: "v3" },
    );
    expect(result).toBe("https://staging.example.com/v3");
  });

  it("uses defaults for server variables when config is missing", () => {
    const result = resolveServerUrl(
      [
        {
          url: "https://{env}.example.com",
          variables: {
            env: { default: "api" },
          },
        },
      ],
      {},
    );
    expect(result).toBe("https://api.example.com");
  });

  it("returns empty string when servers list is empty", () => {
    const result = resolveServerUrl([], {});
    expect(result).toBe("");
  });

  it("encodes variable values", () => {
    const result = resolveServerUrl(
      [
        {
          url: "https://{sub}.example.com",
          variables: {
            sub: { default: "my api" },
          },
        },
      ],
      {},
    );
    expect(result).toBe("https://my%20api.example.com");
  });
});

describe("substitutePathParams", () => {
  it("replaces a single path parameter", () => {
    const result = substitutePathParams("/pets/{petId}", { petId: "123" });
    expect(result).toBe("/pets/123");
  });

  it("replaces multiple path parameters", () => {
    const result = substitutePathParams("/users/{userId}/pets/{petId}", {
      userId: "abc",
      petId: "456",
    });
    expect(result).toBe("/users/abc/pets/456");
  });

  it("returns path unchanged when no params provided", () => {
    const result = substitutePathParams("/pets/123");
    expect(result).toBe("/pets/123");
  });

  it("returns path unchanged when params object is empty", () => {
    const result = substitutePathParams("/pets/{petId}", {});
    expect(result).toBe("/pets/{petId}");
  });

  it("encodes parameter values", () => {
    const result = substitutePathParams("/pets/{name}", {
      name: "fluffy dog",
    });
    expect(result).toBe("/pets/fluffy%20dog");
  });

  it("ignores undefined or null params", () => {
    const result = substitutePathParams("/pets/{petId}", {
      petId: undefined,
      other: "x",
    });
    expect(result).toBe("/pets/{petId}");
  });
});

describe("buildQueryString", () => {
  it("builds a query string from params", () => {
    const result = buildQueryString({ limit: "10", offset: "0" });
    expect(result).toBe("?limit=10&offset=0");
  });

  it("returns empty string for empty params", () => {
    const result = buildQueryString({});
    expect(result).toBe("");
  });

  it("returns empty string for undefined params", () => {
    const result = buildQueryString();
    expect(result).toBe("");
  });

  it("filters out null and undefined values", () => {
    const result = buildQueryString({ a: "1", b: null, c: undefined, d: "2" });
    expect(result).toBe("?a=1&d=2");
  });

  it("handles array values (multi-value query params)", () => {
    const result = buildQueryString({ ids: ["1", "2", "3"] });
    expect(result).toBe("?ids=1&ids=2&ids=3");
  });
});

describe("buildAuthHeaders", () => {
  const schemes = {
    ApiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
    Bearer: { type: "http", scheme: "bearer" },
    Basic: { type: "http", scheme: "basic" },
    OAuth2: { type: "oauth2" },
  };

  it("returns empty headers when security is not provided", () => {
    const result = buildAuthHeaders({ ApiKey: "secret" }, schemes);
    expect(result).toEqual({});
  });

  it("returns empty headers when security is empty", () => {
    const result = buildAuthHeaders({ ApiKey: "secret" }, schemes, []);
    expect(result).toEqual({});
  });

  it("sets header for apiKey scheme", () => {
    const result = buildAuthHeaders({ ApiKey: "my-api-key" }, schemes, [
      { ApiKey: [] },
    ]);
    expect(result).toEqual({ "X-API-Key": "my-api-key" });
  });

  it("sets Authorization Bearer for http bearer scheme", () => {
    const result = buildAuthHeaders({ Bearer: "my-token" }, schemes, [
      { Bearer: [] },
    ]);
    expect(result).toEqual({ Authorization: "Bearer my-token" });
  });

  it("sets Authorization Basic for http basic scheme", () => {
    const result = buildAuthHeaders(
      { Basic: { username: "admin", password: "pass" } },
      schemes,
      [{ Basic: [] }],
    );
    expect(result).toEqual({
      Authorization: `Basic ${Buffer.from("admin:pass").toString("base64")}`,
    });
  });

  it("sets Authorization Bearer for oauth2 scheme", () => {
    const result = buildAuthHeaders({ OAuth2: "oauth-token" }, schemes, [
      { OAuth2: [] },
    ]);
    expect(result).toEqual({ Authorization: "Bearer oauth-token" });
  });

  it("returns empty headers when secret value is missing", () => {
    const result = buildAuthHeaders({}, schemes, [{ ApiKey: [] }]);
    expect(result).toEqual({});
  });

  it("picks second OR entry when first has no matching secret", () => {
    const result = buildAuthHeaders({ Bearer: "my-token" }, schemes, [
      { ApiKey: [] },
      { Bearer: [] },
    ]);
    expect(result).toEqual({ Authorization: "Bearer my-token" });
  });

  it("uses first matching requirement entry (OR semantics)", () => {
    const result = buildAuthHeaders(
      { ApiKey: "key", Bearer: "token" },
      schemes,
      [{ ApiKey: [] }, { Bearer: [] }],
    );
    expect(result).toEqual({ "X-API-Key": "key" });
  });
});

describe("makeRequest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns status and parsed body for a successful JSON response", async () => {
    const mockResponse = new Response(
      JSON.stringify({ id: "123", name: "Fluffy" }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const result = await makeRequest({
      method: "GET",
      url: "https://api.example.com/pets/123",
      timeoutMs: 5000,
    });

    expect(result).toEqual({
      status: "200",
      body: { id: "123", name: "Fluffy" },
    });
  });

  it("sends JSON body for POST/PUT requests", async () => {
    const mockResponse = new Response(
      JSON.stringify({ id: "456", name: "Buddy" }),
      {
        status: 201,
        headers: { "content-type": "application/json" },
      },
    );
    const fetchMock = vi.fn().mockResolvedValue(mockResponse);
    vi.stubGlobal("fetch", fetchMock);

    await makeRequest({
      method: "POST",
      url: "https://api.example.com/pets",
      body: { name: "Buddy" },
      timeoutMs: 5000,
    });

    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[0]).toBe("https://api.example.com/pets");
    expect(callArgs[1].method).toBe("POST");
    expect(callArgs[1].body).toBe(JSON.stringify({ name: "Buddy" }));
    expect(callArgs[1].headers).toMatchObject({
      "content-type": "application/json",
      accept: "application/json",
    });
  });

  it("returns status with no body for 204 response", async () => {
    const mockResponse = new Response(null, {
      status: 204,
      headers: { "content-type": "application/json" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const result = await makeRequest({
      method: "DELETE",
      url: "https://api.example.com/pets/123",
      timeoutMs: 5000,
    });

    expect(result).toEqual({ status: "204" });
  });

  it("throws on non-JSON response body", async () => {
    const mockResponse = new Response("<html>error</html>", {
      status: 500,
      headers: { "content-type": "text/html" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    await expect(
      makeRequest({
        method: "GET",
        url: "https://api.example.com/pets/123",
        timeoutMs: 5000,
      }),
    ).rejects.toThrow("HTTP 500: Non-JSON response body");
  });

  it("throws on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ENOTFOUND")));

    await expect(
      makeRequest({
        method: "GET",
        url: "https://api.example.com/pets/123",
        timeoutMs: 5000,
      }),
    ).rejects.toThrow("ENOTFOUND");
  });

  it("throws on timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValue(
          new DOMException("The operation was aborted", "AbortError"),
        ),
    );

    await expect(
      makeRequest({
        method: "GET",
        url: "https://api.example.com/pets/123",
        timeoutMs: 5000,
      }),
    ).rejects.toThrow("Request timed out after 5000ms");
  });

  it("includes custom headers in the request", async () => {
    const mockResponse = new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const fetchMock = vi.fn().mockResolvedValue(mockResponse);
    vi.stubGlobal("fetch", fetchMock);

    await makeRequest({
      method: "GET",
      url: "https://api.example.com/pets",
      headers: { "X-Custom": "value" },
      timeoutMs: 5000,
    });

    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[1].headers).toMatchObject({
      "X-Custom": "value",
      accept: "application/json",
    });
  });
});
