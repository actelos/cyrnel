import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { db } from "@/db/client";
import { registries, registryAuth } from "@/db/schema";
import { HttpError } from "@/models/error.model";
import { RegistriesService } from "@/services/registries.service";
import { encodeCursor } from "@/utils/pagination.util";
import {
  invalidateAccessToken,
  invalidateRegistryAuthCache,
} from "@/utils/registry-auth.util";

vi.mock("@/utils/download.util", () => ({
  assertRegistryAddressAllowed: vi.fn(async () => undefined),
}));

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../drizzle");

async function applyMigrations(): Promise<void> {
  const existing = await db.run(
    sql.raw(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='registries'",
    ),
  );
  if (existing.rows.length > 0) return;
  const entries = (await fs.readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of entries) {
    const file = await fs.readFile(path.join(MIGRATIONS_DIR, name), "utf8");
    const statements = file
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await db.run(sql.raw(stmt));
    }
  }
}

async function resetDb(): Promise<void> {
  await db.run(sql.raw("PRAGMA foreign_keys = OFF"));
  await db.run(sql.raw("DELETE FROM registries"));
  await db.run(sql.raw("PRAGMA foreign_keys = ON"));
}

const svc = new RegistriesService();

type SeedRow = [id: string, baseUrl: string, createdAt: string];

async function seedRegistries(rows: SeedRow[]): Promise<void> {
  await db.insert(registries).values(
    rows.map(([id, baseUrl, createdAt]) => ({
      id,
      baseUrl,
      lastSyncedAt: null,
      createdAt,
      updatedAt: createdAt,
    })),
  );
}

describe("RegistriesService", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  afterAll(async () => {
    await resetDb();
  });

  beforeEach(async () => {
    await resetDb();
  });

  describe("createRegistry()", () => {
    it("persists a registry with defaults", async () => {
      const record = await svc.createRegistry({
        id: "github",
        baseUrl: "https://registry.github.com",
      });

      expect(record).toMatchObject({
        id: "github",
        baseUrl: "https://registry.github.com/",
        lastSyncedAt: null,
      });
      expect(new Date(record.createdAt).getTime()).not.toBeNaN();
      expect(record.updatedAt).toBe(record.createdAt);

      const [row] = await db
        .select()
        .from(registries)
        .where(eq(registries.id, "github"))
        .limit(1);
      expect(row).toMatchObject(record);
    });

    it("trims the id", async () => {
      const record = await svc.createRegistry({
        id: "  github  ",
        baseUrl: "https://registry.github.com",
      });

      expect(record.id).toBe("github");
    });

    it("normalizes the base URL before storing", async () => {
      const record = await svc.createRegistry({
        id: "plain",
        baseUrl: "https://example.com",
      });

      expect(record.baseUrl).toBe("https://example.com/");
    });

    it.each([
      ["spaces", "foo bar"],
      ["empty", ""],
      ["slash", "foo/bar"],
      ["dot", "foo.bar"],
    ])("rejects id %s", async (_label, id) => {
      await expect(
        svc.createRegistry({ id, baseUrl: "https://example.com" }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it.each([
      ["relative", "example.com"],
      ["unsupported scheme", "ftp://example.com"],
      ["garbage", "not a url"],
    ])("rejects %s base URL", async (_label, baseUrl) => {
      await expect(
        svc.createRegistry({ id: "gh", baseUrl }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects a duplicate id with 409", async () => {
      await svc.createRegistry({
        id: "github",
        baseUrl: "https://registry.github.com",
      });

      await expect(
        svc.createRegistry({
          id: "github",
          baseUrl: "https://other.example.com",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "Registry 'github' already exists.",
      });
    });

    it("rejects a duplicate base URL with 409 even with cosmetic variants", async () => {
      await svc.createRegistry({
        id: "github",
        baseUrl: "https://registry.github.com",
      });

      await expect(
        svc.createRegistry({
          id: "other",
          baseUrl: "https://registry.github.com/",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message:
          "A registry with base URL 'https://registry.github.com/' is already registered.",
      });
    });
  });

  describe("listRegistries()", () => {
    it("returns an empty page for an empty table", async () => {
      expect(await svc.listRegistries()).toEqual({
        items: [],
        nextCursor: null,
        hasMore: false,
      });
    });

    it("orders by createdAt descending", async () => {
      await seedRegistries([
        ["zeta", "https://zeta.example.com", "2024-03-01T00:00:00.000Z"],
        ["alpha", "https://alpha.example.com", "2024-01-01T00:00:00.000Z"],
        ["mid", "https://mid.example.com", "2024-02-01T00:00:00.000Z"],
      ]);

      const { items } = await svc.listRegistries();
      expect(items.map((r) => r.id)).toEqual(["zeta", "mid", "alpha"]);
    });

    it("pages through results with limit and cursor", async () => {
      await seedRegistries([
        ["a", "https://a.example.com", "2024-01-01T00:00:00.000Z"],
        ["b", "https://b.example.com", "2024-01-02T00:00:00.000Z"],
        ["c", "https://c.example.com", "2024-01-03T00:00:00.000Z"],
        ["d", "https://d.example.com", "2024-01-04T00:00:00.000Z"],
        ["e", "https://e.example.com", "2024-01-05T00:00:00.000Z"],
      ]);

      const first = await svc.listRegistries({ limit: 2 });
      expect(first.items.map((r) => r.id)).toEqual(["e", "d"]);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBeTypeOf("string");

      const second = await svc.listRegistries({
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.items.map((r) => r.id)).toEqual(["c", "b"]);
      expect(second.hasMore).toBe(true);

      const third = await svc.listRegistries({
        limit: 2,
        cursor: second.nextCursor ?? undefined,
      });
      expect(third.items.map((r) => r.id)).toEqual(["a"]);
      expect(third.hasMore).toBe(false);
      expect(third.nextCursor).toBeNull();
    });

    it("clamps the limit to the default when omitted", async () => {
      await seedRegistries(
        Array.from({ length: 30 }, (_, i) => [
          `r${i}`,
          `https://r${i}.example.com`,
          new Date(Date.UTC(2024, 0, 1 + i)).toISOString(),
        ]),
      );

      const { items } = await svc.listRegistries();
      expect(items).toHaveLength(20);
    });

    it("rejects a malformed cursor with 400", async () => {
      await expect(
        svc.listRegistries({ cursor: "not-a-cursor" }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects a cursor with the wrong sort-key arity", async () => {
      const cursor = encodeCursor(["2024-01-01T00:00:00.000Z"]);
      await expect(svc.listRegistries({ cursor })).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("rejects a cursor with the wrong sort-key types", async () => {
      const cursor = encodeCursor([42, "zeta"]);
      await expect(svc.listRegistries({ cursor })).rejects.toMatchObject({
        statusCode: 400,
      });
    });
  });

  describe("getRegistry()", () => {
    it("returns the record for an existing id", async () => {
      await svc.createRegistry({
        id: "github",
        baseUrl: "https://registry.github.com",
      });

      const record = await svc.getRegistry("github");
      expect(record).toMatchObject({
        id: "github",
        baseUrl: "https://registry.github.com/",
      });
    });

    it("throws 404 for a missing id", async () => {
      await expect(svc.getRegistry("missing")).rejects.toMatchObject({
        statusCode: 404,
        message: "Registry 'missing' not found.",
      });
    });
  });

  describe("deleteRegistry()", () => {
    it("hard-deletes the row", async () => {
      await svc.createRegistry({
        id: "github",
        baseUrl: "https://registry.github.com",
      });

      await svc.deleteRegistry("github");

      const { items } = await svc.listRegistries();
      expect(items).toEqual([]);
      await expect(svc.getRegistry("github")).rejects.toBeInstanceOf(HttpError);
    });

    it("throws 404 for a missing id", async () => {
      await expect(svc.deleteRegistry("missing")).rejects.toMatchObject({
        statusCode: 404,
      });
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const INDEX = {
  id: "cyrnel-dev",
  "definitions.v1": "/definitions/v1",
  "modules.v1": "/modules/v1",
};

const DEFINITIONS_PAGE = {
  definitions: [
    {
      id: "github",
      name: "GitHub",
      source: "/definitions/github",
      kind: "openapi@3.0",
    },
  ],
  nextCursor: null,
};

const MODULES_PAGE = {
  modules: [
    {
      id: "hello-env",
      name: "Hello Env",
      source: "/modules/hello-env",
      type: "adapter",
    },
  ],
  nextCursor: null,
};

function stubRegistryServer(options?: {
  index?: unknown;
  definitionsPage?: unknown;
  modulesPage?: unknown;
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string) => {
    const url = new URL(String(input));
    if (url.pathname === "/.well-known/registry.json") {
      return jsonResponse(options?.index ?? INDEX);
    }
    if (url.pathname === "/definitions/v1") {
      return jsonResponse(options?.definitionsPage ?? DEFINITIONS_PAGE);
    }
    if (url.pathname === "/modules/v1") {
      return jsonResponse(options?.modulesPage ?? MODULES_PAGE);
    }
    return jsonResponse({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("addRegistry()", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("discovers capabilities and persists using the advertised id", async () => {
    stubRegistryServer();

    const record = await svc.addRegistry("https://registry.example.com");

    expect(record).toMatchObject({
      id: "cyrnel-dev",
      baseUrl: "https://registry.example.com/",
      lastSyncedAt: null,
    });
  });

  it("succeeds for a definitions-only registry", async () => {
    stubRegistryServer({
      index: { id: "defs-only", "definitions.v1": "/definitions/v1" },
    });

    const record = await svc.addRegistry("https://registry.example.com");
    expect(record.id).toBe("defs-only");
  });

  it("succeeds for a modules-only registry", async () => {
    stubRegistryServer({
      index: { id: "mods-only", "modules.v1": "/modules/v1" },
    });

    const record = await svc.addRegistry("https://registry.example.com");
    expect(record.id).toBe("mods-only");
  });

  it("uses an explicit id override even when it differs from the advertised id", async () => {
    stubRegistryServer();

    const record = await svc.addRegistry(
      "https://registry.example.com",
      "local-alias",
    );
    expect(record.id).toBe("local-alias");
  });

  it("rejects a registry advertising no supported capability with 400", async () => {
    stubRegistryServer({ index: { id: "bare" } });

    await expect(
      svc.addRegistry("https://registry.example.com"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("propagates 409 conflicts from createRegistry unchanged", async () => {
    stubRegistryServer();
    await svc.createRegistry({
      id: "cyrnel-dev",
      baseUrl: "https://other.example.com",
    });

    await expect(
      svc.addRegistry("https://registry.example.com"),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "Registry 'cyrnel-dev' already exists.",
    });
  });
});

describe("refreshRegistry()", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stamps lastSyncedAt and updatedAt", async () => {
    stubRegistryServer();
    await svc.createRegistry({
      id: "cyrnel-dev",
      baseUrl: "https://registry.example.com",
    });

    const record = await svc.refreshRegistry("cyrnel-dev");

    expect(record.lastSyncedAt).toBeTypeOf("string");
    expect(record.updatedAt > record.createdAt).toBe(true);
    expect(record.id).toBe("cyrnel-dev");
  });

  it("does not change the id when the advertised id differs", async () => {
    stubRegistryServer({
      index: { id: "renamed-id", "definitions.v1": "/definitions/v1" },
    });
    await svc.createRegistry({
      id: "local-id",
      baseUrl: "https://registry.example.com",
    });

    const record = await svc.refreshRegistry("local-id");

    expect(record.id).toBe("local-id");
  });

  it("throws 502 when the registry loses all supported capabilities", async () => {
    stubRegistryServer({ index: { id: "bare" } });
    await svc.createRegistry({
      id: "cyrnel-dev",
      baseUrl: "https://registry.example.com",
    });

    await expect(svc.refreshRegistry("cyrnel-dev")).rejects.toMatchObject({
      statusCode: 502,
    });
  });

  it("throws 404 for a missing registry", async () => {
    stubRegistryServer();

    await expect(svc.refreshRegistry("missing")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("browseDefinitions() / browseModules()", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes definitions params through to the capability endpoint", async () => {
    const fetchMock = stubRegistryServer();
    await svc.createRegistry({
      id: "cyrnel-dev",
      baseUrl: "https://registry.example.com",
    });

    const page = await svc.browseDefinitions("cyrnel-dev", {
      query: "git",
      kind: "github",
      limit: 25,
    });

    expect(page.entries).toHaveLength(1);
    const definitionsCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/definitions/v1"),
    );
    const sent = new URL(String(definitionsCall?.[0]));
    expect(sent.searchParams.get("query")).toBe("git");
    expect(sent.searchParams.get("kind")).toBe("github");
    expect(sent.searchParams.get("limit")).toBe("25");
  });

  it("passes modules params through to the capability endpoint", async () => {
    const fetchMock = stubRegistryServer();
    await svc.createRegistry({
      id: "cyrnel-dev",
      baseUrl: "https://registry.example.com",
    });

    await svc.browseModules("cyrnel-dev", { type: "adapter" });

    const modulesCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/modules/v1"),
    );
    const sent = new URL(String(modulesCall?.[0]));
    expect(sent.searchParams.get("type")).toBe("adapter");
  });

  it("throws 404 when the registry does not support definitions", async () => {
    stubRegistryServer({
      index: { id: "mods-only", "modules.v1": "/modules/v1" },
    });
    await svc.createRegistry({
      id: "mods-only",
      baseUrl: "https://registry.example.com",
    });

    await expect(svc.browseDefinitions("mods-only", {})).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("throws 404 when the registry does not support modules", async () => {
    stubRegistryServer({
      index: { id: "defs-only", "definitions.v1": "/definitions/v1" },
    });
    await svc.createRegistry({
      id: "defs-only",
      baseUrl: "https://registry.example.com",
    });

    await expect(svc.browseModules("defs-only", {})).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("throws 404 when the registry itself is missing", async () => {
    stubRegistryServer();

    await expect(svc.browseDefinitions("missing", {})).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("seedDefault()", () => {
  const ORIGINAL_DEFAULT = process.env.CYRNEL_DEFAULT_REGISTRY_URL;

  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL_DEFAULT === undefined) {
      delete process.env.CYRNEL_DEFAULT_REGISTRY_URL;
    } else {
      process.env.CYRNEL_DEFAULT_REGISTRY_URL = ORIGINAL_DEFAULT;
    }
  });

  it("skips silently when the env var is unset", async () => {
    delete process.env.CYRNEL_DEFAULT_REGISTRY_URL;

    await svc.seedDefault();

    expect(await svc.listRegistries()).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  it("seeds when the table is empty", async () => {
    process.env.CYRNEL_DEFAULT_REGISTRY_URL = "https://registry.example.com";
    stubRegistryServer();

    await svc.seedDefault();

    const { items } = await svc.listRegistries();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("cyrnel-dev");
  });

  it("does nothing when the table already has registries", async () => {
    process.env.CYRNEL_DEFAULT_REGISTRY_URL = "https://registry.example.com";
    stubRegistryServer();
    await svc.createRegistry({
      id: "existing",
      baseUrl: "https://other.example.com",
    });

    await svc.seedDefault();

    const { items } = await svc.listRegistries();
    expect(items.map((r) => r.id)).toEqual(["existing"]);
  });

  it("swallows a failing fetch", async () => {
    process.env.CYRNEL_DEFAULT_REGISTRY_URL = "https://registry.example.com";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Network failure");
      }),
    );

    await expect(svc.seedDefault()).resolves.toBeUndefined();
    expect(await svc.listRegistries()).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
  });
});

describe("RegistriesService registry auth", () => {
  type Enforcement = "none" | "apikey" | "oauth2";

  interface FixtureState {
    enforcement: Enforcement;
    advertisement: unknown;
    apiKey: string;
    keyHeader: string;
    clientId: string;
    clientSecret: string;
    tokenEndpoint: string | null;
    token: string;
    failNextDefinitions: number;
    tokenExchanges: number;
    tokenBodies: string[];
    definitionsHeaders: Array<Record<string, string | string[] | undefined>>;
  }

  const SECRETS_KEY = crypto.randomBytes(32).toString("base64");
  const originalSecretsKey = process.env.CYRNEL_SECRETS_KEY;
  const originalPreviousKeys = process.env.CYRNEL_SECRETS_PREVIOUS_KEYS;

  const state: FixtureState = {
    enforcement: "none",
    advertisement: undefined,
    apiKey: "fixture-key",
    keyHeader: "X-Fixture-Key",
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
    tokenEndpoint: null,
    token: "fixture-access-token",
    failNextDefinitions: 0,
    tokenExchanges: 0,
    tokenBodies: [],
    definitionsHeaders: [],
  };

  let baseUrl: string;
  let fixtureServer: import("node:http").Server;

  function advertiseApiKey(headerName = state.keyHeader): void {
    state.advertisement = { type: "apiKey", name: headerName };
  }

  function advertiseOAuth2(tokenEndpoint?: string): void {
    state.advertisement = {
      type: "oauth2",
      grantType: "client_credentials",
      tokenEndpoint: tokenEndpoint ?? `${baseUrl}/oauth/token`,
      scopes: [
        { id: "registry:read", description: "Read from the registry" },
        { id: "registry:write", description: "Write to the registry" },
      ],
    };
  }

  function isAuthorized(
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    if (state.enforcement === "apikey") {
      return headers[state.keyHeader.toLowerCase()] === state.apiKey;
    }
    if (state.enforcement === "oauth2") {
      return headers.authorization === `Bearer ${state.token}`;
    }
    return true;
  }

  beforeAll(async () => {
    process.env.CYRNEL_SECRETS_KEY = SECRETS_KEY;
    delete process.env.CYRNEL_SECRETS_PREVIOUS_KEYS;
    await applyMigrations();

    fixtureServer = createServer((req, res) => {
      const url = new URL(
        req.url ?? "/",
        `http://127.0.0.1:${req.socket.localPort ?? 0}`,
      );

      if (req.method === "POST" && url.pathname === "/oauth/token") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        req.on("end", () => {
          state.tokenExchanges += 1;
          state.tokenBodies.push(body);
          const params = new URLSearchParams(body);
          if (
            params.get("client_id") !== state.clientId ||
            params.get("client_secret") !== state.clientSecret
          ) {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_client" }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: state.token,
              token_type: "Bearer",
              expires_in: 3600,
            }),
          );
        });
        return;
      }

      if (url.pathname === "/.well-known/registry.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "auth-fixture",
            ...(state.advertisement === undefined
              ? {}
              : { auth: state.advertisement }),
            "definitions.v1": "/definitions/v1",
          }),
        );
        return;
      }

      if (url.pathname === "/definitions/v1") {
        state.definitionsHeaders.push(req.headers);
        if (state.failNextDefinitions > 0) {
          state.failNextDefinitions -= 1;
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        if (!isAuthorized(req.headers)) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ definitions: [], nextCursor: null }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `Not found: ${url.pathname}` }));
    });

    await new Promise<void>((resolve) => {
      fixtureServer.listen(0, "127.0.0.1", resolve);
    });
    const address = fixtureServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("auth fixture server did not bind a port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    state.tokenEndpoint = `${baseUrl}/oauth/token`;
  });

  afterAll(async () => {
    if (originalSecretsKey === undefined) {
      delete process.env.CYRNEL_SECRETS_KEY;
    } else {
      process.env.CYRNEL_SECRETS_KEY = originalSecretsKey;
    }
    if (originalPreviousKeys === undefined) {
      delete process.env.CYRNEL_SECRETS_PREVIOUS_KEYS;
    } else {
      process.env.CYRNEL_SECRETS_PREVIOUS_KEYS = originalPreviousKeys;
    }
    await new Promise<void>((resolve, reject) => {
      fixtureServer.close((err) => (err ? reject(err) : resolve()));
    });
    await resetDb();
  });

  beforeEach(async () => {
    await db.run(sql.raw("PRAGMA foreign_keys = OFF"));
    await db.run(sql.raw("DELETE FROM registry_auth"));
    await db.run(sql.raw("DELETE FROM registries"));
    await db.run(sql.raw("PRAGMA foreign_keys = ON"));
    invalidateRegistryAuthCache();

    state.enforcement = "none";
    state.advertisement = undefined;
    state.failNextDefinitions = 0;
    state.tokenExchanges = 0;
    state.tokenBodies = [];
    state.definitionsHeaders = [];
  });

  it("stores api key credentials encrypted and attaches them on browse", async () => {
    advertiseApiKey();
    state.enforcement = "apikey";

    const result = await svc.addRegistry(baseUrl, undefined, {
      type: "apiKey",
      apiKey: state.apiKey,
    });

    expect(result.id).toBe("auth-fixture");
    expect(result.auth).toMatchObject({
      type: "apiKey",
      status: "configured",
    });

    const [row] = await db
      .select()
      .from(registryAuth)
      .where(eq(registryAuth.registryId, result.id))
      .limit(1);
    expect(row).toBeDefined();
    expect(row.authType).toBe("apiKey");
    expect(row.headerName).toBe("X-Fixture-Key");
    expect(JSON.stringify(row.config)).not.toContain(state.apiKey);
    expect(JSON.stringify(row.config)).toContain("aes-256-gcm");

    await svc.browseDefinitions(result.id, {});
    const lastHeaders = state.definitionsHeaders.at(-1);
    expect(lastHeaders?.["x-fixture-key"]).toBe(state.apiKey);

    const authState = await svc.getAuthState(result.id);
    expect(authState.authType).toBe("apiKey");
    expect(authState.headerName).toBe("X-Fixture-Key");
    expect(authState.tokenExpiresAt).toBeNull();
  });

  it("list responses expose auth metadata but never secrets", async () => {
    advertiseApiKey();
    state.enforcement = "apikey";
    await svc.addRegistry(baseUrl, undefined, {
      type: "apiKey",
      apiKey: "super-secret-key",
    });

    const { items } = await svc.listRegistries();
    expect(items[0].authType).toBe("apiKey");
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain("super-secret-key");
    expect(serialized).not.toContain("aes-256-gcm");
  });

  it("exchanges oauth2 credentials, caches the token, and browses with the bearer", async () => {
    advertiseOAuth2();
    state.enforcement = "oauth2";

    const result = await svc.addRegistry(baseUrl, undefined, {
      type: "oauth2",
      clientId: state.clientId,
      clientSecret: state.clientSecret,
      scopes: ["registry:read"],
    });

    expect(result.auth).toMatchObject({
      type: "oauth2",
      status: "configured",
    });
    expect(result.auth?.tokenExpiresAt).toBeGreaterThan(Date.now() + 3_500_000);
    expect(state.tokenExchanges).toBe(1);

    const params = new URLSearchParams(state.tokenBodies[0]);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe(state.clientId);
    expect(params.get("scope")).toBe("registry:read");

    await svc.browseDefinitions(result.id, {});
    expect(state.definitionsHeaders.at(-1)?.authorization).toBe(
      `Bearer ${state.token}`,
    );

    const authState = await svc.getAuthState(result.id);
    expect(authState.authType).toBe("oauth2");
    expect(authState.tokenEndpoint).toBe(state.tokenEndpoint);
    expect(authState.tokenExpiresAt).not.toBeNull();
  });

  it("defaults to the full advertised scope set when none is requested", async () => {
    advertiseOAuth2();
    state.enforcement = "oauth2";

    const result = await svc.addRegistry(baseUrl, undefined, {
      type: "oauth2",
      clientId: state.clientId,
      clientSecret: state.clientSecret,
    });

    expect(result.auth?.status).toBe("configured");
    const params = new URLSearchParams(state.tokenBodies[0]);
    expect(params.get("scope")).toBe("registry:read registry:write");
  });

  it("refuses requested scopes the registry does not advertise", async () => {
    advertiseOAuth2();
    state.enforcement = "oauth2";

    await expect(
      svc.addRegistry(baseUrl, undefined, {
        type: "oauth2",
        clientId: state.clientId,
        clientSecret: state.clientSecret,
        scopes: ["registry:read", "registry:admin"],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect((await svc.listRegistries()).items).toHaveLength(0);

    const result = await svc.addRegistry(baseUrl, undefined, {
      type: "oauth2",
      clientId: state.clientId,
      clientSecret: state.clientSecret,
    });
    const exchangesBefore = state.tokenExchanges;
    await expect(
      svc.setRegistryAuth(result.id, {
        type: "oauth2",
        clientId: state.clientId,
        clientSecret: state.clientSecret,
        scopes: ["registry:admin"],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    const [row] = await db.select().from(registryAuth).limit(1);
    expect(row).toBeDefined();
    expect(state.tokenExchanges).toBe(exchangesBefore);
  });

  it("reads back available and configured scopes from the live advertisement", async () => {
    advertiseOAuth2();
    state.enforcement = "oauth2";

    const result = await svc.addRegistry(baseUrl, undefined, {
      type: "oauth2",
      clientId: state.clientId,
      clientSecret: state.clientSecret,
      scopes: ["registry:read"],
    });

    const authState = await svc.getRegistryAuthState(result.id);
    expect(authState.availableScopes).toEqual([
      { id: "registry:read", description: "Read from the registry" },
      { id: "registry:write", description: "Write to the registry" },
    ]);
    expect(authState.configuredScopes).toEqual(["registry:read"]);

    await expect(svc.getRegistryAuthState("missing")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("reads back no scopes when api key auth is configured", async () => {
    advertiseApiKey();
    state.enforcement = "apikey";
    const result = await svc.addRegistry(baseUrl, undefined, {
      type: "apiKey",
      apiKey: state.apiKey,
    });

    const authState = await svc.getRegistryAuthState(result.id);
    expect(authState.availableScopes).toEqual([]);
    expect(authState.configuredScopes).toEqual([]);
  });

  it("exposes advertised scopes before any auth is configured", async () => {
    advertiseOAuth2();
    state.enforcement = "oauth2";
    const result = await svc.addRegistry(baseUrl, undefined);

    const authState = await svc.getRegistryAuthState(result.id);
    expect(authState.authType).toBeNull();
    expect(authState.availableScopes).toEqual([
      { id: "registry:read", description: "Read from the registry" },
      { id: "registry:write", description: "Write to the registry" },
    ]);
    expect(authState.configuredScopes).toEqual([]);
  });

  it("never stores credentials when the methods mismatch", async () => {
    advertiseOAuth2();
    state.enforcement = "oauth2";

    const result = await svc.addRegistry(baseUrl, undefined, {
      type: "apiKey",
      apiKey: "super-secret-key",
    });

    expect(result.auth).toMatchObject({
      type: "apiKey",
      status: "error",
      message: expect.stringContaining("oauth2"),
    });
    expect((await svc.listRegistries()).items).toHaveLength(1);
    const [row] = await db.select().from(registryAuth).limit(1);
    expect(row).toBeUndefined();

    await expect(
      svc.setRegistryAuth(result.id, {
        type: "apiKey",
        apiKey: "super-secret-key",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    const [stillEmpty] = await db.select().from(registryAuth).limit(1);
    expect(stillEmpty).toBeUndefined();
  });

  it("stores the registry with error status when the token exchange fails at setup", async () => {
    advertiseOAuth2();
    state.enforcement = "oauth2";

    const result = await svc.addRegistry(baseUrl, undefined, {
      type: "oauth2",
      clientId: "wrong-client",
      clientSecret: "wrong-secret",
    });

    expect(result.auth).toMatchObject({ type: "oauth2", status: "error" });
    expect((await svc.listRegistries()).items).toHaveLength(1);

    const repaired = await svc.setRegistryAuth(result.id, {
      type: "oauth2",
      clientId: state.clientId,
      clientSecret: state.clientSecret,
    });
    expect(repaired.auth.status).toBe("configured");
    expect(repaired.auth.tokenExpiresAt).not.toBeNull();

    await expect(svc.browseDefinitions(result.id, {})).resolves.toBeDefined();
  });

  it("refuses plaintext-http token endpoints advertised outside loopback", async () => {
    advertiseOAuth2("http://public.invalid/oauth/token");
    state.enforcement = "oauth2";

    await expect(
      svc.addRegistry(baseUrl, undefined, {
        type: "oauth2",
        clientId: state.clientId,
        clientSecret: state.clientSecret,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect((await svc.listRegistries()).items).toHaveLength(0);
  });

  it("keeps the pinned token endpoint when the advertisement drifts", async () => {
    advertiseOAuth2();
    state.enforcement = "oauth2";
    const result = await svc.addRegistry(baseUrl, undefined, {
      type: "oauth2",
      clientId: state.clientId,
      clientSecret: state.clientSecret,
    });

    advertiseOAuth2(`${baseUrl}/oauth/drift-token`);

    await expect(svc.refreshRegistry(result.id)).resolves.toMatchObject({
      id: result.id,
    });

    const authState = await svc.getAuthState(result.id);
    expect(authState.tokenEndpoint).toBe(state.tokenEndpoint);
  });

  it("keeps the pinned header name when the api key advertisement drifts", async () => {
    advertiseApiKey();
    state.enforcement = "apikey";
    const result = await svc.addRegistry(baseUrl, undefined, {
      type: "apiKey",
      apiKey: "super-secret-key",
    });

    advertiseApiKey("X-Fixture-Key-Drift");

    await expect(svc.refreshRegistry(result.id)).resolves.toBeDefined();

    const authState = await svc.getAuthState(result.id);
    expect(authState.headerName).toBe("X-Fixture-Key");
  });

  it("exchanges a single token for concurrent refresh requests", async () => {
    advertiseOAuth2();
    state.enforcement = "oauth2";
    const result = await svc.addRegistry(baseUrl, undefined, {
      type: "oauth2",
      clientId: state.clientId,
      clientSecret: state.clientSecret,
    });
    expect(state.tokenExchanges).toBe(1);

    await invalidateAccessToken(result.id);

    await Promise.all([
      svc.browseDefinitions(result.id, {}),
      svc.browseDefinitions(result.id, {}),
    ]);

    expect(state.tokenExchanges).toBe(2);
  });

  it("retries exactly once with a fresh token after a 401", async () => {
    advertiseOAuth2();
    state.enforcement = "oauth2";
    const result = await svc.addRegistry(baseUrl, undefined, {
      type: "oauth2",
      clientId: state.clientId,
      clientSecret: state.clientSecret,
    });
    expect(state.tokenExchanges).toBe(1);

    await invalidateAccessToken(result.id);
    state.failNextDefinitions = 1;

    await expect(svc.browseDefinitions(result.id, {})).resolves.toBeDefined();
    expect(state.tokenExchanges).toBe(3);
    expect(state.failNextDefinitions).toBe(0);
  });

  it("reuses a stored token across cache reloads", async () => {
    advertiseOAuth2();
    state.enforcement = "oauth2";
    const result = await svc.addRegistry(baseUrl, undefined, {
      type: "oauth2",
      clientId: state.clientId,
      clientSecret: state.clientSecret,
    });

    invalidateRegistryAuthCache();
    invalidateAccessToken(result.id);

    await expect(svc.browseDefinitions(result.id, {})).resolves.toBeDefined();
    expect(state.tokenExchanges).toBe(1);
  });

  it("scopes auth headers to the owning registry", async () => {
    advertiseApiKey();
    state.enforcement = "apikey";
    const resultA = await svc.addRegistry(baseUrl, undefined, {
      type: "apiKey",
      apiKey: state.apiKey,
    });

    const otherKey = "secret-b";
    const otherHeaders: Array<Record<string, string | string[] | undefined>> =
      [];
    const otherServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/.well-known/registry.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "other-fixture",
            auth: { type: "apiKey", name: "X-Other-Key" },
            "definitions.v1": "/definitions/v1",
          }),
        );
        return;
      }
      if (url.pathname === "/definitions/v1") {
        otherHeaders.push(req.headers);
        if (req.headers["x-other-key"] !== otherKey) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ definitions: [], nextCursor: null }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => {
      otherServer.listen(0, "127.0.0.1", resolve);
    });
    const otherAddress = otherServer.address();
    if (otherAddress === null || typeof otherAddress === "string") {
      throw new Error("other fixture server did not bind a port");
    }

    try {
      const resultB = await svc.addRegistry(
        `http://127.0.0.1:${otherAddress.port}`,
        undefined,
        { type: "apiKey", apiKey: otherKey },
      );

      state.definitionsHeaders = [];
      await Promise.all([
        svc.browseDefinitions(resultA.id, {}),
        svc.browseDefinitions(resultB.id, {}),
      ]);

      expect(state.definitionsHeaders.at(-1)?.["x-fixture-key"]).toBe(
        state.apiKey,
      );
      expect(state.definitionsHeaders.at(-1)?.["x-other-key"]).toBeUndefined();
      expect(otherHeaders.at(-1)?.["x-other-key"]).toBe(otherKey);
      expect(otherHeaders.at(-1)?.["x-fixture-key"]).toBeUndefined();

      state.definitionsHeaders = [];
      await svc.browseDefinitions(resultA.id, {});
      expect(state.definitionsHeaders.at(-1)?.["x-other-key"]).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => {
        otherServer.close(() => resolve());
      });
    }
  });

  it("cascades auth rows when a registry is deleted", async () => {
    advertiseApiKey();
    state.enforcement = "apikey";
    const result = await svc.addRegistry(baseUrl, undefined, {
      type: "apiKey",
      apiKey: "super-secret-key",
    });

    await svc.deleteRegistry(result.id);

    const [row] = await db
      .select()
      .from(registryAuth)
      .where(eq(registryAuth.registryId, result.id))
      .limit(1);
    expect(row).toBeUndefined();
  });

  it("setRegistryAuth replaces the method and deleteRegistryAuth removes it", async () => {
    advertiseApiKey();
    state.enforcement = "apikey";
    const result = await svc.addRegistry(baseUrl, undefined, {
      type: "apiKey",
      apiKey: "super-secret-key",
    });

    advertiseOAuth2();
    state.enforcement = "oauth2";
    const replaced = await svc.setRegistryAuth(result.id, {
      type: "oauth2",
      clientId: state.clientId,
      clientSecret: state.clientSecret,
    });
    expect(replaced.auth.status).toBe("configured");
    expect((await svc.getAuthState(result.id)).authType).toBe("oauth2");

    await svc.deleteRegistryAuth(result.id);
    expect((await svc.getAuthState(result.id)).authType).toBeNull();

    await expect(svc.deleteRegistryAuth(result.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
