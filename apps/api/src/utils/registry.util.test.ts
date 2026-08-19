import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "@/models/error.model";
import { assertRegistryAddressAllowed } from "@/utils/download.util";

const assertMock = vi.mocked(assertRegistryAddressAllowed);

vi.mock("@/utils/download.util", () => ({
  assertRegistryAddressAllowed: vi.fn(),
}));

import {
  fetchRegistryCapabilityPage,
  fetchRegistryIndex,
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
        String(input).startsWith("https://registry.example.com")
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

  describe("well-known auth advertisement", () => {
    function indexBodyWithAuth(auth: unknown): Record<string, unknown> {
      return {
        id: "cyrnel-dev",
        ...(auth === undefined ? {} : { auth }),
        "definitions.v1": "/definitions/v1",
      };
    }

    async function fetchIndexWithAuth(auth: unknown) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse(indexBodyWithAuth(auth))),
      );
      return fetchRegistryIndex("https://registry.example.com");
    }

    it("returns null when no auth key is advertised", async () => {
      const index = await fetchIndexWithAuth(undefined);
      expect(index.auth).toBeNull();
    });

    it("parses an apiKey advertisement and trims the header name", async () => {
      const index = await fetchIndexWithAuth({
        type: "apiKey",
        name: "  X-Dev-Key  ",
      });
      expect(index.auth).toEqual({ type: "apiKey", name: "X-Dev-Key" });
    });

    it("accepts apiKey without an 'in' key", async () => {
      const index = await fetchIndexWithAuth({
        type: "apiKey",
        name: "X-Dev-Key",
      });
      expect(index.auth).toEqual({ type: "apiKey", name: "X-Dev-Key" });
    });

    it("marks query-param api keys as unsupported", async () => {
      const index = await fetchIndexWithAuth({
        type: "apiKey",
        name: "key",
        in: "query",
      });
      expect(index.auth).toMatchObject({
        type: "unsupported",
        declaredType: "apiKey",
      });
    });

    it("parses an oauth2 client-credentials advertisement with scopes", async () => {
      const index = await fetchIndexWithAuth({
        type: "oauth2",
        grantType: "client_credentials",
        tokenEndpoint: "https://registry.example.com/oauth/token",
        scopes: ["definitions:read", " modules:read "],
      });
      expect(index.auth).toEqual({
        type: "oauth2",
        grantType: "client_credentials",
        tokenEndpoint: "https://registry.example.com/oauth/token",
        scopes: ["definitions:read", "modules:read"],
      });
    });

    it("omits scopes when not advertised", async () => {
      const index = await fetchIndexWithAuth({
        type: "oauth2",
        grantType: "client_credentials",
        tokenEndpoint: "https://registry.example.com/oauth/token",
      });
      expect(index.auth).toEqual({
        type: "oauth2",
        grantType: "client_credentials",
        tokenEndpoint: "https://registry.example.com/oauth/token",
      });
    });

    it("marks non-client-credentials grants as unsupported", async () => {
      const index = await fetchIndexWithAuth({
        type: "oauth2",
        grantType: "authorization_code",
        tokenEndpoint: "https://registry.example.com/oauth/token",
      });
      expect(index.auth).toMatchObject({
        type: "unsupported",
        declaredType: "oauth2",
      });
    });

    it("rejects an oauth2 advertisement with a non-absolute token endpoint", async () => {
      await expect(
        fetchIndexWithAuth({
          type: "oauth2",
          grantType: "client_credentials",
          tokenEndpoint: "/oauth/token",
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects an oauth2 advertisement with a non-http(s) token endpoint", async () => {
      await expect(
        fetchIndexWithAuth({
          type: "oauth2",
          grantType: "client_credentials",
          tokenEndpoint: "mailto:token@example.com",
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects an oauth2 advertisement with non-string scopes", async () => {
      await expect(
        fetchIndexWithAuth({
          type: "oauth2",
          grantType: "client_credentials",
          tokenEndpoint: "https://registry.example.com/oauth/token",
          scopes: [42],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects an apiKey advertisement without a name", async () => {
      await expect(
        fetchIndexWithAuth({ type: "apiKey" }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("marks unknown auth types as unsupported for forward compatibility", async () => {
      const index = await fetchIndexWithAuth({
        type: "jwt",
        issuer: "https://x",
      });
      expect(index.auth).toEqual({
        type: "unsupported",
        declaredType: "jwt",
      });
    });

    it("rejects a non-object auth value", async () => {
      await expect(fetchIndexWithAuth("apiKey")).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("rejects an auth value with a blank type", async () => {
      await expect(
        fetchIndexWithAuth({ type: " ", name: "X-Key" }),
      ).rejects.toMatchObject({ statusCode: 400 });
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
