import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  AuthScheme,
  ConfigProvider,
  CredentialProvider,
  ResolvedCredential,
} from "@cyrnel/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  buildQueryString,
  makeRequest,
  readOptionalConfig,
  resolveAuthPlacements,
  resolveServerUrl,
  substitutePathParams,
} from "./client";

function configWith(
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

describe("resolveServerUrl", () => {
  it("uses serverUrl override from config when present", async () => {
    const result = await resolveServerUrl(
      [{ url: "https://api.example.com/v1" }],
      configWith({ serverUrl: "https://custom.example.com" }),
    );
    expect(result).toBe("https://custom.example.com");
  });

  it("uses first server url when no override", async () => {
    const result = await resolveServerUrl(
      [{ url: "https://api.example.com/v1" }],
      configWith({}),
    );
    expect(result).toBe("https://api.example.com/v1");
  });

  it("substitutes server variables from config", async () => {
    const result = await resolveServerUrl(
      [
        {
          url: "https://{environment}.example.com/{version}",
          variables: {
            environment: { default: "api" },
            version: { default: "v2" },
          },
        },
      ],
      configWith({ serverVar_environment: "staging", serverVar_version: "v3" }),
    );
    expect(result).toBe("https://staging.example.com/v3");
  });

  it("uses defaults for server variables when config is missing", async () => {
    const result = await resolveServerUrl(
      [
        {
          url: "https://{env}.example.com",
          variables: {
            env: { default: "api" },
          },
        },
      ],
      configWith({}),
    );
    expect(result).toBe("https://api.example.com");
  });

  it("returns empty string when servers list is empty", async () => {
    const result = await resolveServerUrl([], configWith({}));
    expect(result).toBe("");
  });

  it("encodes variable values", async () => {
    const result = await resolveServerUrl(
      [
        {
          url: "https://{sub}.example.com",
          variables: {
            sub: { default: "my api" },
          },
        },
      ],
      configWith({}),
    );
    expect(result).toBe("https://my%20api.example.com");
  });

  it("propagates provider errors for other keys", async () => {
    await expect(
      resolveServerUrl([{ url: "https://api.example.com" }], {
        get: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
  });
});

describe("readOptionalConfig", () => {
  it("returns undefined for unset keys", async () => {
    expect(await readOptionalConfig(configWith({}), "missing")).toBeUndefined();
  });

  it("returns configured values", async () => {
    expect(
      await readOptionalConfig(configWith({ timeoutMs: 5000 }), "timeoutMs"),
    ).toBe(5000);
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

describe("resolveAuthPlacements", () => {
  const schemes: Record<string, AuthScheme> = {
    headerKey: { type: "apiKey", in: "header", paramName: "X-API-Key" },
    queryKey: { type: "apiKey", in: "query", paramName: "key" },
    cookieKey: { type: "apiKey", in: "cookie", paramName: "session" },
    bearer: { type: "http", scheme: "bearer" },
    basic: { type: "basic" },
    oauth: {
      type: "oauth2",
      grantTypes: ["authorizationCode"],
      tokenUrl: "https://example.com/token",
      scopes: {},
      tokenPlacement: {
        in: "header",
        paramName: "Authorization",
        prefix: "Bearer",
      },
    },
  };

  function providerFor(
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

  it("returns empty placements when no security is required", async () => {
    const provider = providerFor({});
    expect(await resolveAuthPlacements(schemes, undefined, provider)).toEqual({
      headers: {},
      query: {},
      cookies: {},
    });
    expect(await resolveAuthPlacements(schemes, [], provider)).toEqual({
      headers: {},
      query: {},
      cookies: {},
    });
  });

  it("places apiKey credentials per scheme location", async () => {
    const provider = providerFor({
      headerKey: { type: "apiKey", value: "h" },
      queryKey: { type: "apiKey", value: "q" },
      cookieKey: { type: "apiKey", value: "c" },
    });
    const result = await resolveAuthPlacements(
      schemes,
      [{ headerKey: [], queryKey: [], cookieKey: [] }],
      provider,
    );
    expect(result).toEqual({
      headers: { "X-API-Key": "h" },
      query: { key: "q" },
      cookies: { session: "c" },
    });
  });

  it("applies prefixes, basic encoding, and bearer tokens", async () => {
    const provider = providerFor({
      bearer: { type: "bearer", token: "tok" },
      basic: { type: "basic", username: "u", password: "p" },
      oauth: { type: "oauth2", accessToken: "at", expiresAt: 1 },
    });
    const result = await resolveAuthPlacements(
      schemes,
      [{ bearer: [], basic: [], oauth: [] }],
      provider,
    );
    expect(result.headers).toEqual({ Authorization: "Bearer at" });
    expect(
      await resolveAuthPlacements(schemes, [{ basic: [] }], provider),
    ).toEqual({
      headers: {
        Authorization: `Basic ${Buffer.from("u:p").toString("base64")}`,
      },
      query: {},
      cookies: {},
    });
    expect(
      await resolveAuthPlacements(schemes, [{ bearer: [] }], provider),
    ).toMatchObject({ headers: { Authorization: "Bearer tok" } });
  });

  it("falls through to the next satisfiable requirement group", async () => {
    const provider = providerFor({
      queryKey: { type: "apiKey", value: "q" },
    });
    const result = await resolveAuthPlacements(
      schemes,
      [{ headerKey: [] }, { queryKey: [] }],
      provider,
    );
    expect(result).toEqual({ headers: {}, query: { key: "q" }, cookies: {} });
  });

  it("selects the first satisfiable group deterministically", async () => {
    const provider = providerFor({
      headerKey: { type: "apiKey", value: "h" },
      queryKey: { type: "apiKey", value: "q" },
    });
    const result = await resolveAuthPlacements(
      schemes,
      [{ headerKey: [] }, { queryKey: [] }],
      provider,
    );
    expect(result).toEqual({
      headers: { "X-API-Key": "h" },
      query: {},
      cookies: {},
    });
  });

  it("throws when no requirement group can be satisfied", async () => {
    const provider = providerFor({});
    await expect(
      resolveAuthPlacements(schemes, [{ headerKey: [] }], provider),
    ).rejects.toThrow("no credential for headerKey");
  });

  it("throws for undeclared schemes", async () => {
    const provider = providerFor({});
    await expect(
      resolveAuthPlacements(schemes, [{ ghost: [] }], provider),
    ).rejects.toThrow("No auth scheme 'ghost' declared");
  });

  it("throws on credential/scheme type mismatch", async () => {
    const provider = providerFor({
      headerKey: { type: "basic", username: "u", password: "p" },
    });
    await expect(
      resolveAuthPlacements(schemes, [{ headerKey: [] }], provider),
    ).rejects.toThrow("expected an API key");
  });

  it("throws when http bearer gets a non-bearer credential", async () => {
    const provider = providerFor({
      bearer: { type: "apiKey", value: "not-a-token" },
    });
    await expect(
      resolveAuthPlacements(schemes, [{ bearer: [] }], provider),
    ).rejects.toThrow("expected a bearer token");
  });

  it("enforces oauth2 scopes against the granted credential scopes", async () => {
    const provider = providerFor({
      oauth: {
        type: "oauth2",
        accessToken: "at",
        expiresAt: 1,
        scopes: ["repo:read"],
      },
    });
    await expect(
      resolveAuthPlacements(schemes, [{ oauth: ["repo:write"] }], provider),
    ).rejects.toThrow("lacks required scopes");
    const result = await resolveAuthPlacements(
      schemes,
      [{ oauth: ["repo:write"] }, { oauth: ["repo:read"] }],
      provider,
    );
    expect(result.headers).toEqual({ Authorization: "Bearer at" });
  });

  it("rejects scoped requirements on non-oauth schemes", async () => {
    const provider = providerFor({
      headerKey: { type: "apiKey", value: "h" },
    });
    await expect(
      resolveAuthPlacements(schemes, [{ headerKey: ["read"] }], provider),
    ).rejects.toThrow("no scope concept");
  });
});
