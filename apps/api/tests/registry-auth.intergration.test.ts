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
import { RegistriesService } from "@/services/registries.service";
import { invalidateRegistryIndexCache } from "@/utils/registry.util";
import {
  fetchWithRegistryAuth,
  headersForUrl,
  invalidateRegistryAuthCache,
} from "@/utils/registry-auth.util";
import { encryptSecrets } from "@/utils/secrets.util";

vi.mock("@/utils/download.util", () => ({
  assertRegistryAddressAllowed: vi.fn(async () => undefined),
}));

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../drizzle");

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

const BASE = "https://reg.example.com";
const TOKEN_URL = `${BASE}/oauth/token`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let wellKnownDoc: Record<string, unknown> = {};
let tokenBodies: string[] = [];
let tokenCalls = 0;
let tokenStatus = 200;
let tokenPayload: Record<string, unknown> = {
  access_token: "cc-token",
  token_type: "Bearer",
  expires_in: 3600,
};

function installFetch(
  resourceHandler?: (url: URL) => Response | null,
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
      return jsonResponse(tokenPayload, tokenStatus);
    }
    const handled = resourceHandler?.(url);
    if (handled) return handled;
    return jsonResponse({ ok: true });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function publicDoc(): Record<string, unknown> {
  return {
    id: "reg",
    "definitions.v1": "/definitions/v1",
    "modules.v1": "/modules/v1",
  };
}

function apiKeyDoc(): Record<string, unknown> {
  return {
    id: "reg",
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

function basicDoc(): Record<string, unknown> {
  return {
    id: "reg",
    auth: {
      schemes: { basic: { type: "basic" } },
      security: [{ basic: [] }],
    },
    "definitions.v1": "/definitions/v1",
    "modules.v1": "/modules/v1",
  };
}

function bearerDoc(): Record<string, unknown> {
  return {
    id: "reg",
    auth: {
      schemes: { bearer: { type: "http", scheme: "bearer" } },
      security: [{ bearer: [] }],
    },
    "definitions.v1": "/definitions/v1",
    "modules.v1": "/modules/v1",
  };
}

function ccDoc(): Record<string, unknown> {
  return {
    id: "reg",
    auth: {
      schemes: {
        oauth2: {
          type: "oauth2",
          grantTypes: ["client_credentials"],
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

function acDoc(): Record<string, unknown> {
  return {
    id: "reg",
    auth: {
      schemes: {
        oauth2: {
          type: "oauth2",
          grantTypes: ["authorization_code"],
          authorizationUrl: `${BASE}/oauth/authorize`,
          tokenUrl: TOKEN_URL,
          scopes: { read: "Read catalog", admin: "Administer catalog" },
        },
      },
      security: [{ oauth2: ["read"] }],
    },
    "definitions.v1": "/definitions/v1",
    "modules.v1": "/modules/v1",
  };
}

function overrideDoc(): Record<string, unknown> {
  return {
    id: "reg",
    auth: {
      schemes: {
        apiKey: { type: "apiKey", in: "header", paramName: "X-Key" },
      },
      security: [{ apiKey: [] }],
    },
    "definitions.v1": { url: "/definitions/v1", security: [] },
    "modules.v1": "/modules/v1",
  };
}

async function insertRegistry(
  id: string,
  baseUrl: string = BASE,
): Promise<void> {
  const now = new Date().toISOString();
  await db.insert(registries).values({
    id,
    baseUrl,
    lastSyncedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

async function insertRegistryCredential(input: {
  registryId: string;
  schemeName: string;
  schemeType: "apiKey" | "basic" | "bearer" | "oauth2";
  status?: "active" | "expired" | "revoked" | "error";
  requestedScopes?: string[];
  grantedScopes?: string[] | null;
  secrets: Record<string, unknown>;
}): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(registryCredentials).values({
    id,
    registryId: input.registryId,
    schemeName: input.schemeName,
    schemeType: input.schemeType,
    status: input.status ?? "active",
    requestedScopes: input.requestedScopes ?? [],
    grantedScopes: input.grantedScopes ?? null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(registryCredentialAuth).values({
    credentialId: id,
    schemeType: input.schemeType,
    payload: encryptSecrets(input.secrets),
    updatedAt: Date.now(),
  });
  invalidateRegistryAuthCache();
  return id;
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
  wellKnownDoc = publicDoc();
  tokenBodies = [];
  tokenCalls = 0;
  tokenStatus = 200;
  tokenPayload = {
    access_token: "cc-token",
    token_type: "Bearer",
    expires_in: 3600,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateRegistryAuthCache();
  invalidateRegistryIndexCache();
});

describe("headersForUrl", () => {
  it("returns null for a public registry without auth", async () => {
    wellKnownDoc = publicDoc();
    installFetch();
    await insertRegistry("r1");

    const headers = await headersForUrl(`${BASE}/definitions/v1`);
    expect(headers).toBeNull();
  });

  it("returns null for a URL outside every registry scope", async () => {
    wellKnownDoc = apiKeyDoc();
    installFetch();
    await insertRegistry("r1");
    await insertRegistryCredential({
      registryId: "r1",
      schemeName: "apiKey",
      schemeType: "apiKey",
      secrets: { apiKey: "secret" },
    });

    const headers = await headersForUrl("https://other.example.com/x");
    expect(headers).toBeNull();
  });

  it("attaches the apiKey value under the declared paramName", async () => {
    wellKnownDoc = apiKeyDoc();
    installFetch();
    await insertRegistry("r1");
    await insertRegistryCredential({
      registryId: "r1",
      schemeName: "apiKey",
      schemeType: "apiKey",
      secrets: { apiKey: "secret" },
    });

    const headers = await headersForUrl(`${BASE}/definitions/v1`);
    expect(headers?.headers["X-Key"]).toBe("secret");
    expect(headers?.schemes).toEqual(["apiKey"]);
    expect(headers?.registryId).toBe("r1");
  });

  it("attaches basic credentials as a Basic authorization header", async () => {
    wellKnownDoc = basicDoc();
    installFetch();
    await insertRegistry("r1");
    await insertRegistryCredential({
      registryId: "r1",
      schemeName: "basic",
      schemeType: "basic",
      secrets: { username: "dev", password: "devpass" },
    });

    const headers = await headersForUrl(`${BASE}/definitions/v1`);
    expect(headers?.headers.authorization).toBe(
      `Basic ${Buffer.from("dev:devpass").toString("base64")}`,
    );
  });

  it("attaches a bearer token as a Bearer authorization header", async () => {
    wellKnownDoc = bearerDoc();
    installFetch();
    await insertRegistry("r1");
    await insertRegistryCredential({
      registryId: "r1",
      schemeName: "bearer",
      schemeType: "bearer",
      secrets: { token: "dev-registry-token" },
    });

    const headers = await headersForUrl(`${BASE}/definitions/v1`);
    expect(headers?.headers.authorization).toBe("Bearer dev-registry-token");
  });

  it("exchanges oauth2 client credentials and attaches the Bearer token", async () => {
    wellKnownDoc = ccDoc();
    installFetch();
    await insertRegistry("r1");
    await insertRegistryCredential({
      registryId: "r1",
      schemeName: "oauth2",
      schemeType: "oauth2",
      requestedScopes: ["read"],
      secrets: { clientId: "c", clientSecret: "s" },
    });

    const headers = await headersForUrl(`${BASE}/definitions/v1`);
    expect(headers?.headers.authorization).toBe("Bearer cc-token");
    expect(tokenCalls).toBe(1);
    const params = new URLSearchParams(tokenBodies[0]);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe("c");
    expect(params.get("scope")).toBe("read");

    const again = await headersForUrl(`${BASE}/definitions/v1`);
    expect(again?.headers.authorization).toBe("Bearer cc-token");
    expect(tokenCalls).toBe(1);
  });

  it("attaches a user-delegated oauth2 access token", async () => {
    wellKnownDoc = acDoc();
    installFetch();
    await insertRegistry("r1");
    await insertRegistryCredential({
      registryId: "r1",
      schemeName: "oauth2",
      schemeType: "oauth2",
      requestedScopes: ["read"],
      grantedScopes: ["read"],
      secrets: {
        accessToken: "ac-token",
        expiresAt: Date.now() + 3_600_000,
      },
    });

    const headers = await headersForUrl(`${BASE}/definitions/v1`);
    expect(headers?.headers.authorization).toBe("Bearer ac-token");
    expect(tokenCalls).toBe(0);
  });

  it("throws 401 when a guarded route has no configured credential", async () => {
    wellKnownDoc = apiKeyDoc();
    installFetch();
    await insertRegistry("r1");

    await expect(headersForUrl(`${BASE}/definitions/v1`)).rejects.toMatchObject(
      { statusCode: 401 },
    );
  });

  it("throws 401 when the credential cannot satisfy the required scopes", async () => {
    wellKnownDoc = {
      id: "reg",
      auth: {
        schemes: {
          oauth2: {
            type: "oauth2",
            grantTypes: ["authorization_code"],
            authorizationUrl: `${BASE}/oauth/authorize`,
            tokenUrl: TOKEN_URL,
            scopes: { read: "Read catalog", admin: "Administer catalog" },
          },
        },
        security: [{ oauth2: ["admin"] }],
      },
      "definitions.v1": "/definitions/v1",
    };
    installFetch();
    await insertRegistry("r1");
    await insertRegistryCredential({
      registryId: "r1",
      schemeName: "oauth2",
      schemeType: "oauth2",
      requestedScopes: ["read"],
      grantedScopes: ["read"],
      secrets: {
        accessToken: "ac-token",
        expiresAt: Date.now() + 3_600_000,
      },
    });

    await expect(headersForUrl(`${BASE}/definitions/v1`)).rejects.toMatchObject(
      { statusCode: 401 },
    );
  });

  it("honors a public per-capability override while guarding the rest", async () => {
    wellKnownDoc = overrideDoc();
    installFetch();
    await insertRegistry("r1");
    await insertRegistryCredential({
      registryId: "r1",
      schemeName: "apiKey",
      schemeType: "apiKey",
      secrets: { apiKey: "secret" },
    });

    const publicHeaders = await headersForUrl(`${BASE}/definitions/v1`);
    expect(publicHeaders).toBeNull();

    const guardedHeaders = await headersForUrl(`${BASE}/modules/v1`);
    expect(guardedHeaders?.headers["X-Key"]).toBe("secret");
  });
});

describe("fetchWithRegistryAuth", () => {
  it("attaches the apiKey header on a same-origin request", async () => {
    wellKnownDoc = apiKeyDoc();
    const fetchMock = installFetch();
    await insertRegistry("r1");
    await insertRegistryCredential({
      registryId: "r1",
      schemeName: "apiKey",
      schemeType: "apiKey",
      secrets: { apiKey: "secret" },
    });

    await fetchWithRegistryAuth(`${BASE}/definitions/v1`);
    const [, init] = fetchMock.mock.calls.at(-1) as [
      string,
      { headers?: Record<string, string> },
    ];
    expect(init.headers?.["X-Key"]).toBe("secret");
  });

  it("sends no auth on a cross-origin request", async () => {
    wellKnownDoc = apiKeyDoc();
    const fetchMock = installFetch();
    await insertRegistry("r1");
    await insertRegistryCredential({
      registryId: "r1",
      schemeName: "apiKey",
      schemeType: "apiKey",
      secrets: { apiKey: "secret" },
    });

    await fetchWithRegistryAuth("https://other.example.com/x");
    const [, init] = fetchMock.mock.calls.at(-1) as [
      string,
      { headers?: Record<string, string> },
    ];
    expect(init.headers?.["X-Key"]).toBeUndefined();
    expect(init.headers?.authorization).toBeUndefined();
  });

  it("retries exactly once with a fresh token after a 401", async () => {
    wellKnownDoc = ccDoc();
    let resourceCalls = 0;
    const fetchMock = installFetch((url) => {
      if (url.pathname === "/resource") {
        resourceCalls += 1;
        if (resourceCalls === 1) {
          return new Response("unauthorized", { status: 401 });
        }
        return jsonResponse({ ok: true });
      }
      return null;
    });
    await insertRegistry("r1");
    await insertRegistryCredential({
      registryId: "r1",
      schemeName: "oauth2",
      schemeType: "oauth2",
      requestedScopes: ["read"],
      secrets: { clientId: "c", clientSecret: "s" },
    });

    const result = await fetchWithRegistryAuth(`${BASE}/resource`);
    expect(result.response.status).toBe(200);

    const resourceCallsWithAuth = fetchMock.mock.calls.filter(
      ([u, init]) =>
        String(u).includes("/resource") &&
        Boolean(
          (init as { headers?: Record<string, string> })?.headers
            ?.authorization,
        ),
    );
    expect(resourceCalls).toBe(2);
    expect(resourceCallsWithAuth).toHaveLength(2);
    expect(tokenCalls).toBe(2);
  });
});

describe("registry auth cleanup on registry deletion", () => {
  it("removes the owned credentials when the registry is deleted", async () => {
    wellKnownDoc = apiKeyDoc();
    installFetch();
    await insertRegistry("r1");
    await insertRegistryCredential({
      registryId: "r1",
      schemeName: "apiKey",
      schemeType: "apiKey",
      secrets: { apiKey: "secret" },
    });

    const storedBefore = await db
      .select()
      .from(registryCredentials)
      .where(eq(registryCredentials.registryId, "r1"));
    expect(storedBefore).toHaveLength(1);

    await new RegistriesService().deleteRegistry("r1");

    const storedAfter = await db
      .select()
      .from(registryCredentials)
      .where(eq(registryCredentials.registryId, "r1"));
    expect(storedAfter).toHaveLength(0);
    const authAfter = await db.select().from(registryCredentialAuth);
    expect(authAfter).toHaveLength(0);
  });
});
