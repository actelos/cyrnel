import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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

  describe("AND semantics across multiple schemes in one requirement", () => {
    it("applies all matched schemes in a single requirement entry", () => {
      const result = buildAuthHeaders(
        { ApiKey: "my-key", Bearer: "my-token" },
        schemes,
        [{ ApiKey: [], Bearer: [] }],
      );
      expect(result).toEqual({
        "X-API-Key": "my-key",
        Authorization: "Bearer my-token",
      });
    });

    it("applies only schemes that have secrets when some are missing", () => {
      const result = buildAuthHeaders({ Bearer: "my-token" }, schemes, [
        { ApiKey: [], Bearer: [] },
      ]);
      expect(result).toEqual({ Authorization: "Bearer my-token" });
    });

    it("returns empty headers when no schemes in the entry have secrets", () => {
      const result = buildAuthHeaders({}, schemes, [
        { ApiKey: [], Bearer: [] },
      ]);
      expect(result).toEqual({});
    });

    it("stops at first entry that produces headers (OR across entries)", () => {
      const combined = {
        ApiKey: "key",
        Bearer: "token",
        OAuth2: "oauth-token",
      };
      const result = buildAuthHeaders(combined, schemes, [
        { ApiKey: [], Bearer: [] },
        { OAuth2: [] },
      ]);
      expect(result).toEqual({
        "X-API-Key": "key",
        Authorization: "Bearer token",
      });
    });

    it("applies apiKey and oauth2 schemes together in same entry", () => {
      const result = buildAuthHeaders(
        { ApiKey: "my-key", OAuth2: "my-token" },
        schemes,
        [{ ApiKey: [], OAuth2: [] }],
      );
      expect(result).toEqual({
        "X-API-Key": "my-key",
        Authorization: "Bearer my-token",
      });
    });
  });
});

describe("makeRequest", () => {
  let server: Server;
  let port: number;
  let slowServer: Server;
  let slowPort: number;
  const seen: Array<{
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const method = req.method as string;
        const url = req.url as string;
        seen.push({
          method,
          url,
          headers: { ...req.headers },
          body,
        });

        const parsedUrl = new URL(
          url,
          `http://${req.headers.host ?? "localhost"}`,
        );

        if (parsedUrl.pathname === "/pets/123" && method === "GET") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "123", name: "Fluffy" }));
        } else if (parsedUrl.pathname === "/pets" && method === "POST") {
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "456" }));
        } else if (method === "DELETE") {
          res.writeHead(204);
          res.end();
        } else if (parsedUrl.pathname === "/echo") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              method: req.method,
              url: req.url,
              headers: req.headers,
              body: body || undefined,
            }),
          );
        } else {
          res.writeHead(500, { "content-type": "text/html" });
          res.end("<html>error</html>");
        }
      });
    });

    slowServer = http.createServer(() => {});

    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    await new Promise<void>((resolve) => slowServer.listen(0, () => resolve()));
    port = (server.address() as AddressInfo).port;
    slowPort = (slowServer.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.close();
    slowServer.close();
  });

  afterEach(() => {
    seen.length = 0;
  });

  it("returns status and parsed body for a successful JSON response", async () => {
    const result = await makeRequest({
      method: "GET",
      url: `http://localhost:${port}/pets/123`,
      timeoutMs: 5000,
    });

    expect(result).toEqual({
      status: "200",
      body: { id: "123", name: "Fluffy" },
    });
  });

  it("sends JSON body for POST/PUT requests", async () => {
    await makeRequest({
      method: "POST",
      url: `http://localhost:${port}/echo`,
      body: { name: "Buddy" },
      timeoutMs: 5000,
    });

    expect(seen[0].method).toBe("POST");
    expect(JSON.parse(seen[0].body)).toEqual({ name: "Buddy" });
    expect(seen[0].headers["content-type"]).toBe("application/json");
  });

  it("returns status with no body for 204 response", async () => {
    const result = await makeRequest({
      method: "DELETE",
      url: `http://localhost:${port}/pets/123`,
      timeoutMs: 5000,
    });

    expect(result).toEqual({ status: "204" });
  });

  it("throws on non-JSON response body", async () => {
    await expect(
      makeRequest({
        method: "GET",
        url: `http://localhost:${port}/not-found`,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow("HTTP 500: Non-JSON response body");
  });

  it("throws on network error", async () => {
    await expect(
      makeRequest({
        method: "GET",
        url: "http://localhost:1/nonexistent",
        timeoutMs: 2000,
      }),
    ).rejects.toThrow();
  });

  it("throws on timeout", async () => {
    await expect(
      makeRequest({
        method: "GET",
        url: `http://localhost:${slowPort}/hang`,
        timeoutMs: 200,
      }),
    ).rejects.toThrow("timed out after 200ms");
  });

  it("includes custom headers in the request", async () => {
    await makeRequest({
      method: "GET",
      url: `http://localhost:${port}/echo`,
      headers: { "X-Custom": "value" },
      timeoutMs: 5000,
    });

    expect(seen[0].headers["x-custom"]).toBe("value");
  });

  it("sets accept header by default", async () => {
    await makeRequest({
      method: "GET",
      url: `http://localhost:${port}/echo`,
      timeoutMs: 5000,
    });

    expect(seen[0].headers.accept).toBe("application/json");
  });
});
