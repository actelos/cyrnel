import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
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
import {
  registries,
  registryCredentialAuth,
  registryCredentials,
} from "@/db/schema";
import { HttpError } from "@/models/error.model";
import { CredentialService } from "@/services/credential.service";
import { RegistriesService } from "@/services/registries.service";
import { encodeCursor } from "@/utils/pagination.util";
import { invalidateRegistryIndexCache } from "@/utils/registry.util";
import { invalidateRegistryAuthCache } from "@/utils/registry-auth.util";
import { encryptSecrets } from "@/utils/secrets.util";

vi.mock("@/utils/download.util", () => ({
  assertRegistryAddressAllowed: vi.fn(async () => undefined),
}));

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../drizzle");

const SECRETS_KEY = crypto.randomBytes(32).toString("base64");
const originalSecretsKey = process.env.CYRNEL_SECRETS_KEY;
const originalPreviousKeys = process.env.CYRNEL_SECRETS_PREVIOUS_KEYS;

const DROP_TABLES = [
  "approval_requests",
  "tool_policies",
  "tools",
  "service_secrets",
  "service_configurations",
  "service_credential_auth",
  "service_credentials",
  "module_credential_auth",
  "module_credentials",
  "registry_credential_auth",
  "registry_credentials",
  "oauth_pendings",
  "pending_authorizations",
  "module_connection_schemes",
  "connection_schemes",
  "oauth_clients",
  "connection_auth",
  "connections",
  "services",
  "module_secrets",
  "module_configurations",
  "modules",
  "registry_auth",
  "registries",
  "process_data",
  "process_logs",
  "processes",
  "sqlite_vec_chunks",
  "tool_embeddings",
  "tools_fts",
  "_drizzle_migrations",
];

async function applyMigrations(): Promise<void> {
  await db.run(sql.raw("PRAGMA foreign_keys = OFF"));
  try {
    for (const name of DROP_TABLES) {
      await db.run(sql.raw(`DROP TABLE IF EXISTS ${name}`));
    }
  } finally {
    await db.run(sql.raw("PRAGMA foreign_keys = ON"));
  }

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
  for (const name of [
    "oauth_pendings",
    "service_credential_auth",
    "service_credentials",
    "module_credential_auth",
    "module_credentials",
    "registry_credential_auth",
    "registry_credentials",
    "oauth_clients",
    "services",
    "modules",
    "registries",
  ]) {
    await db.run(sql.raw(`DELETE FROM ${name}`));
  }
  await db.run(sql.raw("PRAGMA foreign_keys = ON"));
}

const svc = new RegistriesService();
const credSvc = new CredentialService();

const BASE = "https://registry.example.com";
const TOKEN_URL = `${BASE}/oauth/token`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function publicIndex(id = "cyrnel-dev"): Record<string, unknown> {
  return {
    id,
    "definitions.v1": "/definitions/v1",
    "modules.v1": "/modules/v1",
  };
}

function apiKeyIndex(): Record<string, unknown> {
  return {
    id: "cyrnel-dev",
    auth: {
      schemes: {
        apiKey: { type: "apiKey", in: "header", paramName: "X-Key" },
      },
      security: [{ apiKey: [] }],
    },
    "definitions.v1": "/definitions/v1",
    "modules.v1": "/modules/v1",
  };
}

function machineIndex(): Record<string, unknown> {
  return {
    id: "cyrnel-dev",
    auth: {
      schemes: {
        apiKey: { type: "apiKey", in: "header", paramName: "X-Key" },
        basic: { type: "basic" },
        bearer: { type: "http", scheme: "bearer" },
        oauth2: {
          type: "oauth2",
          grantTypes: ["client_credentials"],
          tokenUrl: TOKEN_URL,
          scopes: { read: "Read catalog", write: "Write catalog" },
        },
      },
      security: [{ apiKey: [] }],
    },
    "definitions.v1": "/definitions/v1",
    "modules.v1": "/modules/v1",
  };
}

function acIndex(): Record<string, unknown> {
  return {
    id: "cyrnel-dev",
    auth: {
      schemes: {
        oauth2: {
          type: "oauth2",
          grantTypes: ["authorization_code"],
          authorizationUrl: `${BASE}/oauth/authorize`,
          tokenUrl: TOKEN_URL,
          scopes: { read: "Read catalog" },
        },
      },
      security: [{ oauth2: ["read"] }],
    },
    "definitions.v1": "/definitions/v1",
    "modules.v1": "/modules/v1",
  };
}

let wellKnownDoc: Record<string, unknown> = publicIndex();
let tokenBodies: string[] = [];
let tokenCalls = 0;
let tokenStatus = 200;

function installFetch(
  handlers?: Partial<Record<string, unknown>>,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    const url = new URL(String(input));
    if (url.pathname === "/.well-known/registry.json") {
      return jsonResponse(wellKnownDoc);
    }
    if (url.pathname === "/oauth/token") {
      tokenCalls += 1;
      const raw = init?.body;
      tokenBodies.push(typeof raw === "string" ? raw : String(raw));
      return jsonResponse(
        {
          access_token: "cc-token",
          token_type: "Bearer",
          expires_in: 3600,
        },
        tokenStatus,
      );
    }
    if (url.pathname === "/definitions/v1") {
      return jsonResponse(
        handlers?.definitionsPage ?? { definitions: [], nextCursor: null },
      );
    }
    if (url.pathname === "/modules/v1") {
      return jsonResponse(
        handlers?.modulesPage ?? { modules: [], nextCursor: null },
      );
    }
    return jsonResponse({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function insertRegistryCredential(input: {
  registryId: string;
  schemeName: string;
  schemeType: "apiKey" | "basic" | "bearer" | "oauth2";
  secrets: Record<string, unknown>;
}): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(registryCredentials).values({
    id,
    registryId: input.registryId,
    schemeName: input.schemeName,
    schemeType: input.schemeType,
    status: "active",
    requestedScopes: [],
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(registryCredentialAuth).values({
    credentialId: id,
    schemeType: input.schemeType,
    payload: encryptSecrets(input.secrets),
    updatedAt: Date.now(),
  });
  return id;
}

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

beforeAll(async () => {
  process.env.CYRNEL_SECRETS_KEY = SECRETS_KEY;
  delete process.env.CYRNEL_SECRETS_PREVIOUS_KEYS;
  await applyMigrations();
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
  await resetDb();
});

beforeEach(async () => {
  vi.unstubAllGlobals();
  await resetDb();
  invalidateRegistryAuthCache();
  invalidateRegistryIndexCache();
  wellKnownDoc = publicIndex();
  tokenBodies = [];
  tokenCalls = 0;
  tokenStatus = 200;
});

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateRegistryAuthCache();
  invalidateRegistryIndexCache();
});

describe("RegistriesService", () => {
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

    it("carries configuredSchemes per registry", async () => {
      await svc.createRegistry({ id: "r1", baseUrl: "https://r1.example.com" });
      await svc.createRegistry({ id: "r2", baseUrl: "https://r2.example.com" });
      await insertRegistryCredential({
        registryId: "r1",
        schemeName: "apiKey",
        schemeType: "apiKey",
        secrets: { apiKey: "super-secret-key" },
      });
      await insertRegistryCredential({
        registryId: "r1",
        schemeName: "bearer",
        schemeType: "bearer",
        secrets: { token: "tok" },
      });

      const { items } = await svc.listRegistries();
      const r1 = items.find((r) => r.id === "r1");
      const r2 = items.find((r) => r.id === "r2");
      expect(r1?.configuredSchemes.sort()).toEqual(["apiKey", "bearer"]);
      expect(r2?.configuredSchemes).toEqual([]);

      const serialized = JSON.stringify(items);
      expect(serialized).not.toContain("super-secret-key");
      expect(serialized).not.toContain("aes-256-gcm");
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

    it("cascades owned credentials", async () => {
      await svc.createRegistry({ id: "r1", baseUrl: "https://r1.example.com" });
      await insertRegistryCredential({
        registryId: "r1",
        schemeName: "apiKey",
        schemeType: "apiKey",
        secrets: { apiKey: "k" },
      });

      await svc.deleteRegistry("r1");

      expect(await db.select().from(registryCredentials)).toHaveLength(0);
      expect(await db.select().from(registryCredentialAuth)).toHaveLength(0);
    });

    it("throws 404 for a missing id", async () => {
      await expect(svc.deleteRegistry("missing")).rejects.toMatchObject({
        statusCode: 404,
      });
    });
  });
});

describe("addRegistry()", () => {
  it("discovers capabilities and persists using the advertised id", async () => {
    wellKnownDoc = publicIndex();
    installFetch();

    const record = await svc.addRegistry(BASE);

    expect(record).toMatchObject({
      id: "cyrnel-dev",
      baseUrl: `${BASE}/`,
      lastSyncedAt: null,
    });
    expect(record.auth).toEqual({ schemes: {}, security: [] });
    expect(record.resolvedClients).toEqual({});
  });

  it("returns the advertised auth declaration", async () => {
    wellKnownDoc = machineIndex();
    installFetch();

    const record = await svc.addRegistry(BASE);

    expect(Object.keys(record.auth.schemes).sort()).toEqual([
      "apiKey",
      "basic",
      "bearer",
      "oauth2",
    ]);
    expect(record.auth.security).toEqual([{ apiKey: [] }]);
    expect(record.resolvedClients).toEqual({});
  });

  it("resolves OAuth clients for authorization_code schemes", async () => {
    wellKnownDoc = acIndex();
    installFetch();
    const clientId = await credSvc.createOAuthClient({
      provider: "test-provider",
      clientId: "test-client",
      clientSecret: "test-secret",
      tokenUrl: TOKEN_URL,
      authorizationUrl: `${BASE}/oauth/authorize`,
      availableScopes: ["read"],
    });

    const record = await svc.addRegistry(BASE);

    expect(record.resolvedClients.oauth2).toHaveLength(1);
    expect(record.resolvedClients.oauth2[0]).toMatchObject({
      id: clientId,
      provider: "test-provider",
      scopeCompatible: true,
    });
  });

  it("omits client_credentials-only schemes from resolvedClients", async () => {
    wellKnownDoc = machineIndex();
    installFetch();

    const record = await svc.addRegistry(BASE);

    expect(record.resolvedClients).toEqual({});
  });

  it("succeeds for a definitions-only registry", async () => {
    wellKnownDoc = { id: "defs-only", "definitions.v1": "/definitions/v1" };
    installFetch();

    const record = await svc.addRegistry(BASE);
    expect(record.id).toBe("defs-only");
  });

  it("succeeds for a modules-only registry", async () => {
    wellKnownDoc = { id: "mods-only", "modules.v1": "/modules/v1" };
    installFetch();

    const record = await svc.addRegistry(BASE);
    expect(record.id).toBe("mods-only");
  });

  it("uses an explicit id override even when it differs from the advertised id", async () => {
    wellKnownDoc = publicIndex();
    installFetch();

    const record = await svc.addRegistry(BASE, "local-alias");
    expect(record.id).toBe("local-alias");
  });

  it("rejects a registry advertising no supported capability with 400", async () => {
    wellKnownDoc = { id: "bare" };
    installFetch();

    await expect(svc.addRegistry(BASE)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("propagates 409 conflicts from createRegistry unchanged", async () => {
    wellKnownDoc = publicIndex();
    installFetch();
    await svc.createRegistry({
      id: "cyrnel-dev",
      baseUrl: "https://other.example.com",
    });

    await expect(svc.addRegistry(BASE)).rejects.toMatchObject({
      statusCode: 409,
      message: "Registry 'cyrnel-dev' already exists.",
    });
  });
});

describe("setRegistryAuth()", () => {
  it("configures apiKey material for a declared scheme", async () => {
    wellKnownDoc = machineIndex();
    installFetch();
    await svc.createRegistry({ id: "r1", baseUrl: BASE });

    const result = await svc.setRegistryAuth("r1", {
      schemeName: "apiKey",
      type: "apiKey",
      apiKey: "super-secret-key",
    });

    expect(result.auth.status).toBe("configured");
    expect(result.auth.credential).toMatchObject({
      schemeName: "apiKey",
      schemeType: "apiKey",
      status: "active",
    });
    expect(JSON.stringify(result.auth.credential)).not.toContain(
      "super-secret-key",
    );

    const [row] = await db.select().from(registryCredentialAuth).limit(1);
    expect(row.schemeType).toBe("apiKey");
    expect(JSON.stringify(row.payload)).not.toContain("super-secret-key");

    const { items } = await svc.listRegistries();
    expect(items[0].configuredSchemes).toEqual(["apiKey"]);
  });

  it("configures basic material for a declared scheme", async () => {
    wellKnownDoc = machineIndex();
    installFetch();
    await svc.createRegistry({ id: "r1", baseUrl: BASE });

    const result = await svc.setRegistryAuth("r1", {
      schemeName: "basic",
      type: "basic",
      username: "dev",
      password: "devpass",
    });

    expect(result.auth.status).toBe("configured");
    expect(result.auth.credential).toMatchObject({
      schemeName: "basic",
      schemeType: "basic",
    });
  });

  it("configures bearer material for a declared http/bearer scheme", async () => {
    wellKnownDoc = machineIndex();
    installFetch();
    await svc.createRegistry({ id: "r1", baseUrl: BASE });

    const result = await svc.setRegistryAuth("r1", {
      schemeName: "bearer",
      type: "bearer",
      token: "dev-registry-token",
    });

    expect(result.auth.status).toBe("configured");
    expect(result.auth.credential).toMatchObject({
      schemeName: "bearer",
      schemeType: "bearer",
    });
  });

  it("exchanges oauth2 client credentials immediately", async () => {
    wellKnownDoc = machineIndex();
    installFetch();
    await svc.createRegistry({ id: "r1", baseUrl: BASE });

    const result = await svc.setRegistryAuth("r1", {
      schemeName: "oauth2",
      type: "oauth2",
      grant: "client_credentials",
      clientId: "c",
      clientSecret: "s",
      scopes: ["read"],
    });

    expect(result.auth.status).toBe("configured");
    expect(result.auth.tokenExpiresAt).toBeGreaterThan(Date.now());
    expect(result.auth.credential).toMatchObject({
      schemeName: "oauth2",
      schemeType: "oauth2",
      status: "active",
    });
    expect(tokenCalls).toBe(1);
    const params = new URLSearchParams(tokenBodies[0]);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe("c");
    expect(params.get("scope")).toBe("read");
  });

  it("defaults to the full declared scope set when no scopes are given", async () => {
    wellKnownDoc = machineIndex();
    installFetch();
    await svc.createRegistry({ id: "r1", baseUrl: BASE });

    const result = await svc.setRegistryAuth("r1", {
      schemeName: "oauth2",
      type: "oauth2",
      grant: "client_credentials",
      clientId: "c",
      clientSecret: "s",
    });

    expect(result.auth.status).toBe("configured");
    const params = new URLSearchParams(tokenBodies[0]);
    expect(params.get("scope")).toBe("read write");
  });

  it("rejects scope subsets the registry does not advertise with 400", async () => {
    wellKnownDoc = machineIndex();
    installFetch();
    await svc.createRegistry({ id: "r1", baseUrl: BASE });

    await expect(
      svc.setRegistryAuth("r1", {
        schemeName: "oauth2",
        type: "oauth2",
        grant: "client_credentials",
        clientId: "c",
        clientSecret: "s",
        scopes: ["read", "registry:admin"],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(tokenCalls).toBe(0);
    expect(await db.select().from(registryCredentials)).toHaveLength(0);
  });

  it("stores error status when the token exchange fails", async () => {
    wellKnownDoc = machineIndex();
    tokenStatus = 401;
    installFetch();
    await svc.createRegistry({ id: "r1", baseUrl: BASE });

    const result = await svc.setRegistryAuth("r1", {
      schemeName: "oauth2",
      type: "oauth2",
      grant: "client_credentials",
      clientId: "wrong",
      clientSecret: "wrong",
    });

    expect(result.auth.status).toBe("error");
    expect(result.auth.message).toBeTypeOf("string");
    expect(result.auth.tokenExpiresAt).toBeUndefined();
    expect(result.auth.credential.status).toBe("error");

    tokenStatus = 200;
    const repaired = await svc.setRegistryAuth("r1", {
      schemeName: "oauth2",
      type: "oauth2",
      grant: "client_credentials",
      clientId: "c",
      clientSecret: "s",
    });
    expect(repaired.auth.status).toBe("configured");
  });

  it("refuses authorization_code-only schemes with a pointer to the oauth2 flow", async () => {
    wellKnownDoc = acIndex();
    installFetch();
    await svc.createRegistry({ id: "r1", baseUrl: BASE });

    await expect(
      svc.setRegistryAuth("r1", {
        schemeName: "oauth2",
        type: "oauth2",
        grant: "client_credentials",
        clientId: "c",
        clientSecret: "s",
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("authorize flow"),
    });
    expect(await db.select().from(registryCredentials)).toHaveLength(0);
  });

  it("rejects material whose type mismatches the declaration with 400", async () => {
    wellKnownDoc = apiKeyIndex();
    installFetch();
    await svc.createRegistry({ id: "r1", baseUrl: BASE });

    await expect(
      svc.setRegistryAuth("r1", {
        schemeName: "apiKey",
        type: "bearer",
        token: "tok",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await db.select().from(registryCredentials)).toHaveLength(0);
  });

  it("rejects an undeclared scheme with 400", async () => {
    wellKnownDoc = apiKeyIndex();
    installFetch();
    await svc.createRegistry({ id: "r1", baseUrl: BASE });

    await expect(
      svc.setRegistryAuth("r1", {
        schemeName: "nope",
        type: "apiKey",
        apiKey: "k",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("throws 404 for a missing registry", async () => {
    installFetch();

    await expect(
      svc.setRegistryAuth("missing", {
        schemeName: "apiKey",
        type: "apiKey",
        apiKey: "k",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("getRegistryAuthState()", () => {
  it("returns schemes, security, and configured credentials", async () => {
    wellKnownDoc = machineIndex();
    installFetch();
    await svc.createRegistry({ id: "r1", baseUrl: BASE });
    await svc.setRegistryAuth("r1", {
      schemeName: "apiKey",
      type: "apiKey",
      apiKey: "super-secret-key",
    });

    const state = await svc.getRegistryAuthState("r1");

    expect(Object.keys(state.schemes).sort()).toEqual([
      "apiKey",
      "basic",
      "bearer",
      "oauth2",
    ]);
    expect(state.security).toEqual([{ apiKey: [] }]);
    expect(state.credentials).toHaveLength(1);
    expect(state.credentials[0]).toMatchObject({
      schemeName: "apiKey",
      schemeType: "apiKey",
    });
    expect(JSON.stringify(state)).not.toContain("super-secret-key");
  });

  it("returns empty credentials before anything is configured", async () => {
    wellKnownDoc = apiKeyIndex();
    installFetch();
    await svc.createRegistry({ id: "r1", baseUrl: BASE });

    const state = await svc.getRegistryAuthState("r1");

    expect(Object.keys(state.schemes)).toEqual(["apiKey"]);
    expect(state.credentials).toEqual([]);
  });

  it("throws 404 for a missing registry", async () => {
    installFetch();

    await expect(svc.getRegistryAuthState("missing")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("deleteRegistryAuth()", () => {
  it("removes a single scheme slot", async () => {
    installFetch();
    await svc.createRegistry({ id: "r1", baseUrl: BASE });
    await insertRegistryCredential({
      registryId: "r1",
      schemeName: "apiKey",
      schemeType: "apiKey",
      secrets: { apiKey: "k" },
    });
    await insertRegistryCredential({
      registryId: "r1",
      schemeName: "bearer",
      schemeType: "bearer",
      secrets: { token: "tok" },
    });

    await svc.deleteRegistryAuth("r1", "apiKey");

    const remaining = await db
      .select({ schemeName: registryCredentials.schemeName })
      .from(registryCredentials)
      .where(eq(registryCredentials.registryId, "r1"));
    expect(remaining.map((r) => r.schemeName)).toEqual(["bearer"]);
    expect(await db.select().from(registryCredentialAuth)).toHaveLength(1);
    const { items } = await svc.listRegistries();
    expect(items[0].configuredSchemes).toEqual(["bearer"]);
  });

  it("removes every slot when no scheme is given", async () => {
    installFetch();
    await svc.createRegistry({ id: "r1", baseUrl: BASE });
    await insertRegistryCredential({
      registryId: "r1",
      schemeName: "apiKey",
      schemeType: "apiKey",
      secrets: { apiKey: "k" },
    });
    await insertRegistryCredential({
      registryId: "r1",
      schemeName: "bearer",
      schemeType: "bearer",
      secrets: { token: "tok" },
    });

    await svc.deleteRegistryAuth("r1");

    expect(await db.select().from(registryCredentials)).toHaveLength(0);
    expect(await db.select().from(registryCredentialAuth)).toHaveLength(0);
  });

  it("throws 404 when the scheme slot is empty", async () => {
    wellKnownDoc = apiKeyIndex();
    installFetch();
    await svc.createRegistry({ id: "r1", baseUrl: BASE });

    await expect(svc.deleteRegistryAuth("r1", "apiKey")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("throws 404 for a missing registry", async () => {
    installFetch();

    await expect(svc.deleteRegistryAuth("missing")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("refreshRegistry()", () => {
  it("stamps lastSyncedAt and updatedAt", async () => {
    wellKnownDoc = publicIndex();
    installFetch();
    await svc.createRegistry({ id: "cyrnel-dev", baseUrl: BASE });

    const record = await svc.refreshRegistry("cyrnel-dev");

    expect(record.lastSyncedAt).toBeTypeOf("string");
    expect(record.updatedAt > record.createdAt).toBe(true);
    expect(record.id).toBe("cyrnel-dev");
  });

  it("does not change the id when the advertised id differs", async () => {
    wellKnownDoc = publicIndex("renamed-id");
    installFetch();
    await svc.createRegistry({ id: "local-id", baseUrl: BASE });

    const record = await svc.refreshRegistry("local-id");

    expect(record.id).toBe("local-id");
  });

  it("throws 502 when the registry loses all supported capabilities", async () => {
    wellKnownDoc = { id: "bare" };
    installFetch();
    await svc.createRegistry({ id: "cyrnel-dev", baseUrl: BASE });

    await expect(svc.refreshRegistry("cyrnel-dev")).rejects.toMatchObject({
      statusCode: 502,
    });
  });

  it("keeps configured credentials when the advertisement drops auth (best-effort drift warning)", async () => {
    wellKnownDoc = apiKeyIndex();
    installFetch();
    await svc.createRegistry({ id: "r1", baseUrl: BASE });
    await svc.setRegistryAuth("r1", {
      schemeName: "apiKey",
      type: "apiKey",
      apiKey: "k",
    });

    wellKnownDoc = publicIndex();
    invalidateRegistryIndexCache();
    const record = await svc.refreshRegistry("r1");

    expect(record.id).toBe("r1");
    const state = await svc.getRegistryAuthState("r1");
    expect(state.schemes).toEqual({});
    expect(state.credentials).toHaveLength(1);
  });

  it("keeps configured credentials when the advertised scheme drifts (best-effort drift warning)", async () => {
    wellKnownDoc = apiKeyIndex();
    installFetch();
    await svc.createRegistry({ id: "r1", baseUrl: BASE });
    await svc.setRegistryAuth("r1", {
      schemeName: "apiKey",
      type: "apiKey",
      apiKey: "k",
    });

    wellKnownDoc = {
      id: "cyrnel-dev",
      auth: {
        schemes: {
          apiKey: {
            type: "apiKey",
            in: "header",
            paramName: "X-Key-Drift",
          },
        },
        security: [{ apiKey: [] }],
      },
      "definitions.v1": "/definitions/v1",
    };
    invalidateRegistryIndexCache();
    await expect(svc.refreshRegistry("r1")).resolves.toMatchObject({
      id: "r1",
    });
    const state = await svc.getRegistryAuthState("r1");
    expect(state.credentials).toHaveLength(1);
  });

  it("throws 404 for a missing registry", async () => {
    wellKnownDoc = publicIndex();
    installFetch();

    await expect(svc.refreshRegistry("missing")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("browseDefinitions() / browseModules()", () => {
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

  it("passes definitions params through to the capability endpoint", async () => {
    wellKnownDoc = publicIndex("cyrnel-dev");
    const fetchMock = installFetch({ definitionsPage: DEFINITIONS_PAGE });
    await svc.createRegistry({ id: "cyrnel-dev", baseUrl: BASE });

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
    wellKnownDoc = publicIndex("cyrnel-dev");
    const fetchMock = installFetch({ modulesPage: MODULES_PAGE });
    await svc.createRegistry({ id: "cyrnel-dev", baseUrl: BASE });

    await svc.browseModules("cyrnel-dev", { type: "adapter" });

    const modulesCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/modules/v1"),
    );
    const sent = new URL(String(modulesCall?.[0]));
    expect(sent.searchParams.get("type")).toBe("adapter");
  });

  it("throws 404 when the registry does not support definitions", async () => {
    wellKnownDoc = { id: "mods-only", "modules.v1": "/modules/v1" };
    installFetch();
    await svc.createRegistry({ id: "mods-only", baseUrl: BASE });

    await expect(svc.browseDefinitions("mods-only", {})).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("throws 404 when the registry does not support modules", async () => {
    wellKnownDoc = { id: "defs-only", "definitions.v1": "/definitions/v1" };
    installFetch();
    await svc.createRegistry({ id: "defs-only", baseUrl: BASE });

    await expect(svc.browseModules("defs-only", {})).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("throws 404 when the registry itself is missing", async () => {
    wellKnownDoc = publicIndex();
    installFetch();

    await expect(svc.browseDefinitions("missing", {})).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("seedDefault()", () => {
  const ORIGINAL_DEFAULT = process.env.CYRNEL_DEFAULT_REGISTRY_URL;

  afterEach(() => {
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
    process.env.CYRNEL_DEFAULT_REGISTRY_URL = BASE;
    wellKnownDoc = publicIndex();
    installFetch();

    await svc.seedDefault();

    const { items } = await svc.listRegistries();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("cyrnel-dev");
  });

  it("does nothing when the table already has registries", async () => {
    process.env.CYRNEL_DEFAULT_REGISTRY_URL = BASE;
    wellKnownDoc = publicIndex();
    installFetch();
    await svc.createRegistry({
      id: "existing",
      baseUrl: "https://other.example.com",
    });

    await svc.seedDefault();

    const { items } = await svc.listRegistries();
    expect(items.map((r) => r.id)).toEqual(["existing"]);
  });

  it("swallows a failing fetch", async () => {
    process.env.CYRNEL_DEFAULT_REGISTRY_URL = BASE;
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
