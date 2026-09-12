import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "@/models/error.model";
import { assertRegistryAddressAllowed } from "@/utils/download.util";

const assertMock = vi.mocked(assertRegistryAddressAllowed);

vi.mock("@/utils/download.util", () => ({
  assertRegistryAddressAllowed: vi.fn(),
}));

import {
  effectiveSecurityForUrl,
  fetchCachedRegistryIndex,
  fetchRegistryCapabilityPage,
  fetchRegistryIndex,
  invalidateRegistryIndexCache,
  type RegistryIndexInfo,
  resolveModuleRegistry,
  resolveServiceRegistry,
} from "@/utils/registry.util";

function mockFetchJson(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

function mockFetchError(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Network failure");
    }),
  );
}

function versioned(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    latestVersion: "1.0.0",
    versions: {
      "1.0.0": entry,
    },
  };
}

describe("resolveModuleRegistry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns downloadUrl from a valid response", async () => {
    mockFetchJson(
      versioned({ downloadUrl: "https://example.com/mod.tar.zst" }),
    );
    const result = await resolveModuleRegistry(
      "https://registry.example.com/mod",
    );
    expect(result.downloadUrl).toBe("https://example.com/mod.tar.zst");
    expect(result.version).toBe("1.0.0");
    expect(result.hash).toBeUndefined();
  });

  it("returns hash when present", async () => {
    mockFetchJson(
      versioned({
        downloadUrl: "https://example.com/mod.tar.zst",
        hash: "abc123",
      }),
    );
    const result = await resolveModuleRegistry(
      "https://registry.example.com/mod",
    );
    expect(result.downloadUrl).toBe("https://example.com/mod.tar.zst");
    expect(result.hash).toBe("abc123");
  });

  it("throws 400 when downloadUrl is missing", async () => {
    mockFetchJson({});
    await expect(
      resolveModuleRegistry("https://registry.example.com/mod"),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("throws 400 when downloadUrl is empty", async () => {
    mockFetchJson(versioned({ downloadUrl: "" }));
    await expect(
      resolveModuleRegistry("https://registry.example.com/mod"),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("throws 400 when downloadUrl is not a string", async () => {
    mockFetchJson(versioned({ downloadUrl: 123 }));
    await expect(
      resolveModuleRegistry("https://registry.example.com/mod"),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("throws 400 when registry returns invalid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 200 })),
    );
    await expect(
      resolveModuleRegistry("https://registry.example.com/mod"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("throws 502 on fetch failure", async () => {
    mockFetchError();
    await expect(
      resolveModuleRegistry("https://registry.example.com/mod"),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it("throws 502 on non-OK response", async () => {
    mockFetchJson({ error: "not found" }, 404);
    await expect(
      resolveModuleRegistry("https://registry.example.com/mod"),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it("trims downloadUrl whitespace", async () => {
    mockFetchJson(
      versioned({ downloadUrl: "  https://example.com/mod.tar.zst  " }),
    );
    const result = await resolveModuleRegistry(
      "https://registry.example.com/mod",
    );
    expect(result.downloadUrl).toBe("https://example.com/mod.tar.zst");
  });

  it("throws 400 when hash is present but empty", async () => {
    mockFetchJson(
      versioned({
        downloadUrl: "https://example.com/mod.tar.zst",
        hash: "",
      }),
    );
    await expect(
      resolveModuleRegistry("https://registry.example.com/mod"),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("returns icon when present", async () => {
    mockFetchJson(
      versioned({
        downloadUrl: "https://example.com/mod.tar.zst",
        icon: { url: "https://example.com/icon.png", hash: "abc123" },
      }),
    );
    const result = await resolveModuleRegistry(
      "https://registry.example.com/mod",
    );
    expect(result.icon).toEqual({
      url: "https://example.com/icon.png",
      hash: "abc123",
    });
  });

  it("throws 400 when icon is not an object", async () => {
    mockFetchJson(
      versioned({
        downloadUrl: "https://example.com/mod.tar.zst",
        icon: "https://example.com/icon.png",
      }),
    );
    await expect(
      resolveModuleRegistry("https://registry.example.com/mod"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("throws 400 when icon url is missing or empty", async () => {
    mockFetchJson(
      versioned({
        downloadUrl: "https://example.com/mod.tar.zst",
        icon: { hash: "abc123" },
      }),
    );
    await expect(
      resolveModuleRegistry("https://registry.example.com/mod"),
    ).rejects.toMatchObject({ statusCode: 400 });

    mockFetchJson(
      versioned({
        downloadUrl: "https://example.com/mod.tar.zst",
        icon: { url: "", hash: "abc123" },
      }),
    );
    await expect(
      resolveModuleRegistry("https://registry.example.com/mod"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("throws 400 when icon hash is missing or empty", async () => {
    mockFetchJson(
      versioned({
        downloadUrl: "https://example.com/mod.tar.zst",
        icon: { url: "https://example.com/icon.png" },
      }),
    );
    await expect(
      resolveModuleRegistry("https://registry.example.com/mod"),
    ).rejects.toMatchObject({ statusCode: 400 });

    mockFetchJson(
      versioned({
        downloadUrl: "https://example.com/mod.tar.zst",
        icon: { url: "https://example.com/icon.png", hash: "" },
      }),
    );
    await expect(
      resolveModuleRegistry("https://registry.example.com/mod"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("trims icon url and hash", async () => {
    mockFetchJson(
      versioned({
        downloadUrl: "https://example.com/mod.tar.zst",
        icon: { url: "  https://example.com/icon.png  ", hash: "  abc  " },
      }),
    );
    const result = await resolveModuleRegistry(
      "https://registry.example.com/mod",
    );
    expect(result.icon).toEqual({
      url: "https://example.com/icon.png",
      hash: "abc",
    });
  });
});

describe("resolveServiceRegistry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns downloadUrl from a valid response", async () => {
    mockFetchJson(versioned({ downloadUrl: "https://example.com/svc.json" }));
    const result = await resolveServiceRegistry(
      "https://registry.example.com/svc",
    );
    expect(result.downloadUrl).toBe("https://example.com/svc.json");
    expect(result.version).toBe("1.0.0");
    expect(result.hash).toBeUndefined();
    expect(result.id).toBeUndefined();
    expect(result.kind).toBeUndefined();
  });

  it("returns optional fields when present", async () => {
    mockFetchJson(
      versioned({
        downloadUrl: "https://example.com/svc.json",
        hash: "def456",
        id: "my-service",
        kind: "openapi@3.0",
      }),
    );
    const result = await resolveServiceRegistry(
      "https://registry.example.com/svc",
    );
    expect(result.downloadUrl).toBe("https://example.com/svc.json");
    expect(result.hash).toBe("def456");
    expect(result.id).toBe("my-service");
    expect(result.kind).toBe("openapi@3.0");
  });

  it("throws 400 when downloadUrl is missing", async () => {
    mockFetchJson({});
    await expect(
      resolveServiceRegistry("https://registry.example.com/svc"),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("throws 502 on fetch failure", async () => {
    mockFetchError();
    await expect(
      resolveServiceRegistry("https://registry.example.com/svc"),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it("throws 400 when id is present but empty", async () => {
    mockFetchJson(
      versioned({
        downloadUrl: "https://example.com/svc.json",
        id: "",
      }),
    );
    await expect(
      resolveServiceRegistry("https://registry.example.com/svc"),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("throws 400 when kind is present but empty", async () => {
    mockFetchJson(
      versioned({
        downloadUrl: "https://example.com/svc.json",
        kind: "",
      }),
    );
    await expect(
      resolveServiceRegistry("https://registry.example.com/svc"),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("trims all string fields", async () => {
    mockFetchJson(
      versioned({
        downloadUrl: "  https://example.com/svc.json  ",
        hash: "  abc  ",
        id: "  my-svc  ",
        kind: "  openapi@3.0  ",
      }),
    );
    const result = await resolveServiceRegistry(
      "https://registry.example.com/svc",
    );
    expect(result.downloadUrl).toBe("https://example.com/svc.json");
    expect(result.hash).toBe("abc");
    expect(result.id).toBe("my-svc");
    expect(result.kind).toBe("openapi@3.0");
  });

  it("returns icon when present", async () => {
    mockFetchJson(
      versioned({
        downloadUrl: "https://example.com/svc.json",
        icon: { url: "https://example.com/icon.png", hash: "def456" },
      }),
    );
    const result = await resolveServiceRegistry(
      "https://registry.example.com/svc",
    );
    expect(result.icon).toEqual({
      url: "https://example.com/icon.png",
      hash: "def456",
    });
  });

  it("throws 400 when icon is present but malformed", async () => {
    mockFetchJson(
      versioned({
        downloadUrl: "https://example.com/svc.json",
        icon: { url: "https://example.com/icon.png" },
      }),
    );
    await expect(
      resolveServiceRegistry("https://registry.example.com/svc"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

const WELL_KNOWN = {
  id: "cyrnel-dev",
  "definitions.v1": "/definitions/v1",
  "modules.v1": "/modules/v1",
};

describe("fetchRegistryIndex", () => {
  beforeEach(() => {
    assertMock.mockResolvedValue(undefined);
    invalidateRegistryIndexCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses the capability map and negotiates the highest supported version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          id: "cyrnel-dev",
          "definitions.v1": "/definitions/v1",
          "modules.v1": "/modules/v1",
        }),
      ),
    );
    const index = await fetchRegistryIndex("https://registry.example.com");

    expect(index.id).toBe("cyrnel-dev");
    expect(index.definitions).toEqual({
      version: 1,
      url: "https://registry.example.com/definitions/v1",
    });
    expect(index.modules).toEqual({
      version: 1,
      url: "https://registry.example.com/modules/v1",
    });
  });

  it("resolves relative capability URLs against the post-redirect discovery URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        (() => {
          const url = new URL(String(input));
          return (
            url.protocol === "https:" && url.hostname === "registry.example.com"
          );
        })()
          ? redirectResponse(
              "https://mirror.example.com/.well-known/registry.json",
            )
          : jsonResponse({
              id: "mirrored",
              "definitions.v1": "/definitions/v1",
            }),
      ),
    );
    const index = await fetchRegistryIndex("https://registry.example.com");

    expect(index.finalUrl).toBe(
      "https://mirror.example.com/.well-known/registry.json",
    );
    expect(index.definitions?.url).toBe(
      "https://mirror.example.com/definitions/v1",
    );
  });

  it("resolves unsupported capability versions to null, not an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          id: "future",
          "definitions.v9": "/definitions/v9",
        }),
      ),
    );
    const index = await fetchRegistryIndex("https://registry.example.com");

    expect(index.definitions).toBeNull();
    expect(index.modules).toBeNull();
  });

  it("parses a response with zero recognized capabilities without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id: "bare" })),
    );
    const index = await fetchRegistryIndex("https://registry.example.com");

    expect(index.id).toBe("bare");
    expect(index.definitions).toBeNull();
    expect(index.modules).toBeNull();
  });

  it("silently ignores unrecognized keys, including a name key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          id: "cyrnel-dev",
          name: "Cyrnel Dev Registry",
          "definitions.v1": "/definitions/v1",
          unknownKey: { nested: true },
        }),
      ),
    );
    const index = await fetchRegistryIndex("https://registry.example.com");

    expect(index.id).toBe("cyrnel-dev");
    expect(index.definitions).not.toBeNull();
  });

  it("throws 400 when the advertised id is not a slug", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id: "not a slug" })),
    );
    await expect(
      fetchRegistryIndex("https://registry.example.com"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("throws 400 when a capability URL resolves cross-origin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          id: "evil",
          "definitions.v1": "https://evil.example.com/definitions/v1",
        }),
      ),
    );
    await expect(
      fetchRegistryIndex("https://registry.example.com"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("re-validates the address at every redirect hop", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        redirectResponse("http://169.254.169.254/.well-known/registry.json"),
      ),
    );
    assertMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new HttpError(
          502,
          "Registry download blocked: address is not publicly routable.",
        ),
      );

    await expect(
      fetchRegistryIndex("https://registry.example.com"),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(assertMock).toHaveBeenCalledWith(
      "http://169.254.169.254/.well-known/registry.json",
    );
  });

  it("throws 502 when redirects exceed the hop limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (String(input).endsWith("/hop6")) return jsonResponse(WELL_KNOWN);
        const current = new URL(String(input));
        const next =
          Number(current.pathname.match(/^\/hop(\d+)$/)?.[1] ?? 0) + 1;
        return redirectResponse(`https://registry.example.com/hop${next}`);
      }),
    );

    await expect(
      fetchRegistryIndex("https://registry.example.com/hop0"),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it("throws 502 when a redirect has no Location header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302 })),
    );
    await expect(
      fetchRegistryIndex("https://registry.example.com"),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  describe("v2 well-known auth advertisement", () => {
    const ORIGIN = "https://registry.example.com";

    function indexBodyWithAuth(auth: unknown): Record<string, unknown> {
      return {
        id: "cyrnel-dev",
        ...(auth === undefined ? {} : { auth }),
        "definitions.v1": "/definitions/v1",
        "modules.v1": "/modules/v1",
      };
    }

    async function fetchIndexWithAuth(auth: unknown) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse(indexBodyWithAuth(auth))),
      );
      return fetchRegistryIndex(ORIGIN);
    }

    function oauth2CcScheme(overrides: Record<string, unknown> = {}) {
      return {
        type: "oauth2",
        grantTypes: ["client_credentials"],
        tokenUrl: `${ORIGIN}/oauth/token`,
        scopes: { read: "Read catalog" },
        ...overrides,
      };
    }

    function v2Auth(overrides: Record<string, unknown> = {}) {
      return {
        schemes: {
          apiKey: {
            type: "apiKey",
            in: "header",
            paramName: "X-Key",
          },
        },
        security: [{ apiKey: [] }],
        ...overrides,
      };
    }

    it("returns null when no auth key is advertised", async () => {
      const index = await fetchIndexWithAuth(undefined);
      expect(index.auth).toBeNull();
    });

    it("parses a multi-scheme auth declaration with global security", async () => {
      const index = await fetchIndexWithAuth({
        schemes: {
          apiKey: {
            type: "apiKey",
            in: "header",
            paramName: "  X-Key  ",
            prefix: " ApiKey ",
          },
          basic: { type: "basic" },
          bearer: { type: "http", scheme: "bearer" },
          oauth2: {
            type: "oauth2",
            grantTypes: ["authorization_code", "client_credentials"],
            authorizationUrl: `${ORIGIN}/oauth/authorize`,
            tokenUrl: `${ORIGIN}/oauth/token`,
            scopes: { read: "Read catalog" },
          },
        },
        security: [{ oauth2: ["read"] }, { apiKey: [] }],
      });

      expect(index.auth?.schemes.apiKey).toMatchObject({
        type: "apiKey",
        in: "header",
        paramName: "X-Key",
        prefix: "ApiKey",
      });
      expect(index.auth?.schemes.basic).toEqual({ type: "basic" });
      expect(index.auth?.schemes.bearer).toEqual({
        type: "http",
        scheme: "bearer",
      });
      expect(index.auth?.schemes.oauth2).toMatchObject({
        type: "oauth2",
        grantTypes: ["authorization_code", "client_credentials"],
        authorizationUrl: `${ORIGIN}/oauth/authorize`,
        tokenUrl: `${ORIGIN}/oauth/token`,
        scopes: { read: "Read catalog" },
      });
      expect(index.auth?.security).toEqual([
        { oauth2: ["read"] },
        { apiKey: [] },
      ]);
    });

    it("accepts a public registry with empty global security", async () => {
      const index = await fetchIndexWithAuth(v2Auth({ security: [] }));
      expect(index.auth?.security).toEqual([]);
    });

    it("rejects the old single-method apiKey shape", async () => {
      await expect(
        fetchIndexWithAuth({ type: "apiKey", name: "X-Dev-Key" }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects the old single-method oauth2 shape", async () => {
      await expect(
        fetchIndexWithAuth({
          type: "oauth2",
          grantType: "client_credentials",
          tokenEndpoint: `${ORIGIN}/oauth/token`,
          scopes: [{ id: "read", description: "Read" }],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects an unknown scheme type", async () => {
      await expect(
        fetchIndexWithAuth(
          v2Auth({ schemes: { jwt: { type: "jwt", issuer: "https://x" } } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects an empty schemes map", async () => {
      await expect(
        fetchIndexWithAuth(v2Auth({ schemes: {} })),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects a missing security array", async () => {
      const { security: _dropped, ...withoutSecurity } = v2Auth();
      void _dropped;
      await expect(fetchIndexWithAuth(withoutSecurity)).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("rejects a non-object auth value", async () => {
      await expect(fetchIndexWithAuth("apiKey")).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("rejects security referencing an undeclared scheme", async () => {
      await expect(
        fetchIndexWithAuth(v2Auth({ security: [{ nope: [] }] })),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects non-empty scopes on a non-oauth2 scheme", async () => {
      await expect(
        fetchIndexWithAuth(v2Auth({ security: [{ apiKey: ["read"] }] })),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects oauth2 scopes that the scheme does not declare", async () => {
      await expect(
        fetchIndexWithAuth({
          schemes: { oauth2: oauth2CcScheme() },
          security: [{ oauth2: ["admin"] }],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects an oauth2 scheme with an unsupported grant", async () => {
      await expect(
        fetchIndexWithAuth({
          schemes: { oauth2: oauth2CcScheme({ grantTypes: ["implicit"] }) },
          security: [],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects an oauth2 scheme with an empty grant list", async () => {
      await expect(
        fetchIndexWithAuth({
          schemes: { oauth2: oauth2CcScheme({ grantTypes: [] }) },
          security: [],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects an oauth2 scheme without a tokenUrl", async () => {
      const { tokenUrl: _dropped, ...withoutTokenUrl } = oauth2CcScheme();
      void _dropped;
      await expect(
        fetchIndexWithAuth({
          schemes: { oauth2: withoutTokenUrl },
          security: [],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects an oauth2 tokenUrl off the registry origin", async () => {
      await expect(
        fetchIndexWithAuth({
          schemes: {
            oauth2: oauth2CcScheme({
              tokenUrl: "https://evil.example.com/oauth/token",
            }),
          },
          security: [],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects an oauth2 scheme with a relative tokenUrl", async () => {
      await expect(
        fetchIndexWithAuth({
          schemes: { oauth2: oauth2CcScheme({ tokenUrl: "/oauth/token" }) },
          security: [],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("requires authorizationUrl when authorization_code is granted", async () => {
      await expect(
        fetchIndexWithAuth({
          schemes: {
            oauth2: {
              type: "oauth2",
              grantTypes: ["authorization_code"],
              tokenUrl: `${ORIGIN}/oauth/token`,
              scopes: {},
            },
          },
          security: [],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects an authorizationUrl off the registry origin", async () => {
      await expect(
        fetchIndexWithAuth({
          schemes: {
            oauth2: {
              type: "oauth2",
              grantTypes: ["authorization_code"],
              authorizationUrl: "https://evil.example.com/oauth/authorize",
              tokenUrl: `${ORIGIN}/oauth/token`,
              scopes: {},
            },
          },
          security: [],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects an http scheme that is not bearer", async () => {
      await expect(
        fetchIndexWithAuth(
          v2Auth({ schemes: { h: { type: "http", scheme: "basic" } } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects an apiKey scheme without a paramName", async () => {
      await expect(
        fetchIndexWithAuth(
          v2Auth({ schemes: { k: { type: "apiKey", in: "header" } } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects an apiKey scheme with a non-header placement", async () => {
      await expect(
        fetchIndexWithAuth(
          v2Auth({
            schemes: { k: { type: "apiKey", in: "query", paramName: "key" } },
            security: [{ k: [] }],
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("parses per-capability string and object forms", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse({
            id: "cyrnel-dev",
            auth: {
              schemes: {
                apiKey: { type: "apiKey", in: "header", paramName: "X-Key" },
                oauth2: oauth2CcScheme(),
              },
              security: [{ apiKey: [] }],
            },
            "definitions.v1": {
              url: "/definitions/v1",
              security: [],
            },
            "modules.v1": "/modules/v1",
          }),
        ),
      );
      const index = await fetchRegistryIndex(ORIGIN);

      expect(index.definitions).toEqual({
        version: 1,
        url: "https://registry.example.com/definitions/v1",
        security: [],
      });
      expect(index.modules).toEqual({
        version: 1,
        url: "https://registry.example.com/modules/v1",
      });
    });

    it("rejects a per-capability object without a url", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse({
            id: "cyrnel-dev",
            "definitions.v1": { security: [] },
          }),
        ),
      );
      await expect(fetchRegistryIndex(ORIGIN)).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("rejects a non-string non-object capability value", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse({
            id: "cyrnel-dev",
            "definitions.v1": 42,
          }),
        ),
      );
      await expect(fetchRegistryIndex(ORIGIN)).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("rejects a per-capability url resolving cross-origin", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse({
            id: "cyrnel-dev",
            "definitions.v1": {
              url: "https://evil.example.com/definitions/v1",
              security: [],
            },
          }),
        ),
      );
      await expect(fetchRegistryIndex(ORIGIN)).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("rejects per-capability security referencing an undeclared scheme", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse({
            id: "cyrnel-dev",
            auth: v2Auth(),
            "definitions.v1": {
              url: "/definitions/v1",
              security: [{ nope: [] }],
            },
          }),
        ),
      );
      await expect(fetchRegistryIndex(ORIGIN)).rejects.toMatchObject({
        statusCode: 400,
      });
    });
  });

  describe("effectiveSecurityForUrl", () => {
    function guardedIndex(): RegistryIndexInfo {
      return {
        id: "cyrnel-dev",
        finalUrl: "https://registry.example.com/.well-known/registry.json",
        definitions: {
          version: 1,
          url: "https://registry.example.com/definitions/v1",
        },
        modules: {
          version: 1,
          url: "https://registry.example.com/modules/v1",
          security: [{ oauth2: ["read"] }],
        },
        auth: {
          schemes: {
            apiKey: { type: "apiKey", in: "header", paramName: "X-Key" },
            oauth2: {
              type: "oauth2",
              grantTypes: ["client_credentials"],
              tokenUrl: "https://registry.example.com/oauth/token",
              scopes: { read: "Read" },
              tokenPlacement: {
                in: "header",
                paramName: "Authorization",
                prefix: "Bearer",
              },
            },
          },
          security: [{ apiKey: [] }],
        },
      };
    }

    it("returns the global security for an inherited capability route", () => {
      const index = guardedIndex();
      expect(
        effectiveSecurityForUrl(
          index,
          "https://registry.example.com/definitions/v1",
        ),
      ).toEqual([{ apiKey: [] }]);
    });

    it("returns the per-capability override for an overridden route", () => {
      const index = guardedIndex();
      expect(
        effectiveSecurityForUrl(
          index,
          "https://registry.example.com/modules/v1?limit=10",
        ),
      ).toEqual([{ oauth2: ["read"] }]);
    });

    it("returns the override for entry downloads under the capability path", () => {
      const index = guardedIndex();
      expect(
        effectiveSecurityForUrl(
          index,
          "https://registry.example.com/modules/github/archive.tar.zst",
        ),
      ).toEqual([{ oauth2: ["read"] }]);
    });

    it("returns [] for a public registry without auth", () => {
      const index: RegistryIndexInfo = {
        id: "bare",
        finalUrl: "https://registry.example.com/.well-known/registry.json",
        definitions: {
          version: 1,
          url: "https://registry.example.com/definitions/v1",
        },
        modules: null,
        auth: null,
      };
      expect(
        effectiveSecurityForUrl(
          index,
          "https://registry.example.com/definitions/v1",
        ),
      ).toEqual([]);
    });

    it("falls back to global security for unknown paths and bad URLs", () => {
      const index = guardedIndex();
      expect(
        effectiveSecurityForUrl(index, "https://registry.example.com/other"),
      ).toEqual([{ apiKey: [] }]);
      expect(effectiveSecurityForUrl(index, "not-a-url")).toEqual([
        { apiKey: [] },
      ]);
    });
  });

  describe("fetchCachedRegistryIndex", () => {
    beforeEach(() => {
      assertMock.mockResolvedValue(undefined);
      invalidateRegistryIndexCache();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("caches the well-known document per base URL", async () => {
      const fetchMock = vi.fn(async () => jsonResponse(WELL_KNOWN));
      vi.stubGlobal("fetch", fetchMock);

      const first = await fetchCachedRegistryIndex(
        "https://registry.example.com",
      );
      const second = await fetchCachedRegistryIndex(
        "https://registry.example.com",
      );

      expect(first.id).toBe("cyrnel-dev");
      expect(second).toBe(first);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("refetches after invalidateRegistryIndexCache(baseUrl)", async () => {
      const fetchMock = vi.fn(async () => jsonResponse(WELL_KNOWN));
      vi.stubGlobal("fetch", fetchMock);

      await fetchCachedRegistryIndex("https://registry.example.com");
      invalidateRegistryIndexCache("https://registry.example.com");
      await fetchCachedRegistryIndex("https://registry.example.com");

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("invalidateRegistryIndexCache() clears every entry", async () => {
      const fetchMock = vi.fn(async () => jsonResponse(WELL_KNOWN));
      vi.stubGlobal("fetch", fetchMock);

      await fetchCachedRegistryIndex("https://a.example.com");
      await fetchCachedRegistryIndex("https://b.example.com");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      invalidateRegistryIndexCache();
      await fetchCachedRegistryIndex("https://a.example.com");
      await fetchCachedRegistryIndex("https://b.example.com");
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });
});

const DEFINITIONS_PAGE = {
  definitions: [
    {
      id: "github",
      name: "GitHub",
      description: "Repo tooling",
      source: "/definitions/github",
      kind: "openapi@3.0",
    },
  ],
  nextCursor: "abc",
};

describe("fetchRegistryCapabilityPage", () => {
  beforeEach(() => {
    assertMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses a valid page and round-trips nextCursor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(DEFINITIONS_PAGE)),
    );
    const page = await fetchRegistryCapabilityPage(
      "https://registry.example.com/definitions/v1",
      "definitions",
      { limit: 50 },
    );

    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({
      id: "github",
      name: "GitHub",
      description: "Repo tooling",
      kind: "openapi@3.0",
      source: "https://registry.example.com/definitions/github",
    });
    expect(page.nextCursor).toBe("abc");
  });

  it("rejects a definitions entry with a malformed kind", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          definitions: [{ id: "x", source: "/definitions/x", kind: "github" }],
          nextCursor: null,
        }),
      ),
    );
    await expect(
      fetchRegistryCapabilityPage(
        "https://registry.example.com/definitions/v1",
        "definitions",
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("resolves entry sources against the capability URL and enforces same-origin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          definitions: [{ id: "x", source: "https://evil.example.com/desc" }],
          nextCursor: null,
        }),
      ),
    );
    await expect(
      fetchRegistryCapabilityPage(
        "https://registry.example.com/definitions/v1",
        "definitions",
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("sends query, kind, cursor and limit parameters", async () => {
    const fetchMock = vi.fn(async (_input: string) =>
      jsonResponse(DEFINITIONS_PAGE),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchRegistryCapabilityPage(
      "https://registry.example.com/definitions/v1",
      "definitions",
      { query: "git", kind: "github", cursor: "c2VjcmV0", limit: 25 },
    );

    const sent = new URL(String(fetchMock.mock.calls[0][0]));
    expect(sent.searchParams.get("query")).toBe("git");
    expect(sent.searchParams.get("kind")).toBe("github");
    expect(sent.searchParams.get("cursor")).toBe("c2VjcmV0");
    expect(sent.searchParams.get("limit")).toBe("25");
  });

  it("sends type for modules and defaults limit to 50", async () => {
    const fetchMock = vi.fn(async (_input: string) =>
      jsonResponse({
        modules: [
          { id: "py-env", source: "/modules/py-env", type: "environment" },
        ],
        nextCursor: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchRegistryCapabilityPage(
      "https://registry.example.com/modules/v1",
      "modules",
      { type: "environment" },
    );

    const sent = new URL(String(fetchMock.mock.calls[0][0]));
    expect(sent.searchParams.get("type")).toBe("environment");
    expect(sent.searchParams.get("limit")).toBe("50");
  });

  it("rejects an entry with a bad type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          modules: [{ id: "x", source: "/modules/x", type: "wat" }],
          nextCursor: null,
        }),
      ),
    );
    await expect(
      fetchRegistryCapabilityPage(
        "https://registry.example.com/modules/v1",
        "modules",
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an entry missing its source", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ definitions: [{ id: "x" }], nextCursor: null }),
      ),
    );
    await expect(
      fetchRegistryCapabilityPage(
        "https://registry.example.com/definitions/v1",
        "definitions",
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a response missing the capability array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ nextCursor: null })),
    );
    await expect(
      fetchRegistryCapabilityPage(
        "https://registry.example.com/definitions/v1",
        "definitions",
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a non-string nextCursor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ definitions: [], nextCursor: 42 })),
    );
    await expect(
      fetchRegistryCapabilityPage(
        "https://registry.example.com/definitions/v1",
        "definitions",
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an oversized response", async () => {
    const huge = {
      definitions: Array.from({ length: 4000 }, (_, i) => ({
        id: `entry-${i}`,
        name: "x".repeat(120),
        source: `/definitions/entry-${i}`,
      })),
      nextCursor: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(huge)),
    );
    await expect(
      fetchRegistryCapabilityPage(
        "https://registry.example.com/definitions/v1",
        "definitions",
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
