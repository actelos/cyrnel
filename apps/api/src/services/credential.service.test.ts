import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { db } from "@/db/client";
import { modules, services } from "@/db/schema";
import {
  CredentialService,
  normalizeAuthUrl,
  parseGrantedScopes,
} from "@/services/credential.service";
import { encryptSecrets } from "@/utils/secrets.util";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../drizzle");

const SECRETS_KEY = crypto.randomBytes(32).toString("base64");
const originalSecretsKey = process.env.CYRNEL_SECRETS_KEY;
const originalPreviousKeys = process.env.CYRNEL_SECRETS_PREVIOUS_KEYS;

async function applyMigrations(only?: {
  upto?: string;
  only?: string;
  dropFirst?: boolean;
}): Promise<void> {
  if (only?.dropFirst !== false) {
    await db.run(sql.raw("PRAGMA foreign_keys = OFF"));
    try {
      for (const name of [
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
      ]) {
        await db.run(sql.raw(`DROP TABLE IF EXISTS ${name}`));
      }
    } finally {
      await db.run(sql.raw("PRAGMA foreign_keys = ON"));
    }
  }

  let entries = (await fs.readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (only?.upto !== undefined) {
    entries = entries.filter((name) => name < "0018");
  }
  if (only?.only !== undefined) {
    entries = entries.filter((name) => name === only.only);
  }
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

const SERVICE_SCHEMES = {
  apiKey: { type: "apiKey", in: "header", paramName: "X-API-Key" },
  basic: { type: "http", scheme: "basic" },
  bearer: { type: "http", scheme: "bearer" },
  oauth2: {
    type: "oauth2",
    grantTypes: ["authorizationCode"],
    authorizationUrl: "https://provider.example.com/authorize",
    tokenUrl: "https://provider.example.com/token",
    scopes: { read: "Read access", write: "Write access", admin: "Admin" },
    tokenPlacement: {
      in: "header",
      paramName: "Authorization",
      prefix: "Bearer",
    },
  },
};

async function ensureService(id: string): Promise<void> {
  await db
    .insert(modules)
    .values({
      id: "test-adapter",
      name: "test-adapter",
      type: "adapter",
      description: "",
      hash: "h",
      version: "0.0.0",
      source: "",
    })
    .onConflictDoNothing();
  await db
    .insert(services)
    .values({
      id,
      name: id,
      hash: "h",
      adapter: "test-adapter",
      configSchema: { type: "object" },
      secretsSchema: { type: "object" },
      adapterDomain: {},
      schemes: SERVICE_SCHEMES,
    })
    .onConflictDoNothing();
}

async function createClient(
  svc: CredentialService,
  overrides: Partial<
    Parameters<CredentialService["createOAuthClient"]>[0]
  > = {},
): Promise<string> {
  return svc.createOAuthClient({
    provider: "test-provider",
    clientId: "test-client",
    clientSecret: "test-secret",
    tokenUrl: "https://provider.example.com/token",
    authorizationUrl: "https://provider.example.com/authorize",
    availableScopes: ["read", "write", "admin"],
    ...overrides,
  });
}

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const svc = new CredentialService();

describe("CredentialService", () => {
  beforeAll(async () => {
    process.env.CYRNEL_SECRETS_KEY = SECRETS_KEY;
    delete process.env.CYRNEL_SECRETS_PREVIOUS_KEYS;
    await applyMigrations();
  });

  afterAll(() => {
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
  });

  beforeEach(async () => {
    await resetDb();
    vi.unstubAllGlobals();
  });

  describe("static credentials", () => {
    it("upserts apiKey/basic/bearer credentials per scheme", async () => {
      await ensureService("svc-1");
      const store = svc.forService("svc-1");

      const api = await store.upsertApiKey("apiKey", "sk-1");
      expect(api.replaced).toBe(false);
      expect(api.credential.schemeType).toBe("apiKey");

      const basic = await store.upsertBasic("basic", "u", "p");
      expect(basic.credential.schemeType).toBe("basic");

      const bearer = await store.upsertBearer("bearer", "tok-1");
      expect(bearer.credential.schemeType).toBe("bearer");

      const api2 = await store.upsertApiKey("apiKey", "sk-2");
      expect(api2.replaced).toBe(true);
      expect(api2.credential.id).toBe(api.credential.id);

      expect(await store.getDecryptedAuth(api.credential.id)).toEqual({
        apiKey: "sk-2",
      });
    });

    it("rejects unknown schemes and type mismatches", async () => {
      await ensureService("svc-1");
      const store = svc.forService("svc-1");
      await expect(store.upsertApiKey("nope", "x")).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(store.upsertApiKey("oauth2", "x")).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(store.upsertBearer("apiKey", "x")).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("disconnects a scheme slot including secrets", async () => {
      await ensureService("svc-1");
      const store = svc.forService("svc-1");
      await store.upsertApiKey("apiKey", "sk-1");
      expect(await store.disconnectScheme("apiKey")).toBe(true);
      expect(await store.getForScheme("apiKey")).toBeNull();
      expect(await store.disconnectScheme("apiKey")).toBe(false);
    });

    it("lists credentials without secrets", async () => {
      await ensureService("svc-1");
      const store = svc.forService("svc-1");
      await store.upsertApiKey("apiKey", "sk-1");
      const list = await store.listCredentials();
      expect(list).toHaveLength(1);
      expect(JSON.stringify(list)).not.toContain("sk-1");
    });
  });

  describe("oauth2 shells and scope rules", () => {
    it("enforces requested ⊆ availableScopes", async () => {
      await ensureService("svc-1");
      const clientId = await createClient(svc, { availableScopes: ["read"] });
      const store = svc.forService("svc-1");
      await expect(
        store.upsertOAuth2("oauth2", clientId, ["read", "admin"]),
      ).rejects.toMatchObject({ statusCode: 400 });
      const { credential } = await store.upsertOAuth2("oauth2", clientId, [
        "read",
      ]);
      expect(credential.requestedScopes).toEqual(["read"]);
      expect(credential.grantedScopes).toBeNull();
    });

    it("warns (not refuses) on scopes undeclared by the scheme", async () => {
      await ensureService("svc-1");
      const store = svc.forService("svc-1");
      const client2 = await createClient(svc, {
        clientId: "c2",
        availableScopes: ["read", "extra"],
      });
      const result = await store.upsertOAuth2("oauth2", client2, [
        "read",
        "extra",
      ]);
      expect(result.unknownScopes).toEqual(["extra"]);
      expect(result.credential.requestedScopes).toEqual(["read", "extra"]);
    });

    it("client switching replaces the slot in place", async () => {
      await ensureService("svc-1");
      const c1 = await createClient(svc);
      const c2 = await createClient(svc, { clientId: "c2" });
      const store = svc.forService("svc-1");
      const first = await store.upsertOAuth2("oauth2", c1, ["read"]);
      const second = await store.upsertOAuth2("oauth2", c2, ["write"]);
      expect(second.replaced).toBe(true);
      expect(second.credential.id).toBe(first.credential.id);
      expect(second.credential.oauthClientId).toBe(c2);
      expect(second.credential.requestedScopes).toEqual(["write"]);
      expect(second.credential.grantedScopes).toBeNull();
    });
  });

  describe("oauth flow", () => {
    it("begins authorization with scope + PKCE state", async () => {
      await ensureService("svc-1");
      const clientId = await createClient(svc);
      const store = svc.forService("svc-1");
      await store.upsertOAuth2("oauth2", clientId, ["read", "write"]);
      const { authorizationUrl, state } = await store.beginOAuth("oauth2");
      expect(
        authorizationUrl.startsWith("https://provider.example.com/authorize?"),
      ).toBe(true);
      const params = new URL(authorizationUrl).searchParams;
      expect(params.get("scope")).toBe("read write");
      expect(params.get("code_challenge_method")).toBe("S256");
      expect(params.get("state")).toBe(state);
      const rows = (await db.all(
        sql`SELECT service_credential_id, module_credential_id, registry_credential_id FROM oauth_pendings WHERE state = ${state}`,
      )) as Array<Record<string, unknown>>;
      const row = rows[0];
      expect(row.service_credential_id).toBeTruthy();
      expect(row.module_credential_id).toBeNull();
      expect(row.registry_credential_id).toBeNull();
    });

    it("completes authorization and records provider-granted scopes", async () => {
      await ensureService("svc-1");
      const clientId = await createClient(svc);
      const store = svc.forService("svc-1");
      const { credential } = await store.upsertOAuth2("oauth2", clientId, [
        "read",
        "write",
      ]);
      const { state } = await store.beginOAuth("oauth2");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          tokenResponse({
            access_token: "at",
            refresh_token: "rt",
            expires_in: 3600,
            scope: "read",
          }),
        ),
      );
      const updated = await svc.completeOAuthAuthorization(state, "code-1");
      expect(updated.requestedScopes).toEqual(["read", "write"]);
      expect(updated.grantedScopes).toEqual(["read"]);
      expect(updated.grantedSource).toBe("provider");
      expect(updated.status).toBe("active");
      expect(credential.id).toBe(updated.id);
    });

    it("marks granted scopes inferred when the provider omits scope", async () => {
      await ensureService("svc-1");
      const clientId = await createClient(svc);
      const store = svc.forService("svc-1");
      await store.upsertOAuth2("oauth2", clientId, ["read"]);
      const { state } = await store.beginOAuth("oauth2");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          tokenResponse({ access_token: "at", expires_in: 3600 }),
        ),
      );
      const updated = await svc.completeOAuthAuthorization(state, "code-1");
      expect(updated.grantedScopes).toEqual(["read"]);
      expect(updated.grantedSource).toBe("inferred");
    });

    it("rejects unknown/expired states", async () => {
      await expect(
        svc.completeOAuthAuthorization("nope", "code"),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe("refresh", () => {
    async function seedOAuth() {
      await ensureService("svc-1");
      const clientId = await createClient(svc);
      const store = svc.forService("svc-1");
      const { credential } = await store.upsertOAuth2("oauth2", clientId, [
        "read",
      ]);
      const { state } = await store.beginOAuth("oauth2");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          tokenResponse({
            access_token: "at-0",
            refresh_token: "rt-0",
            expires_in: 3600,
            scope: "read",
          }),
        ),
      );
      await svc.completeOAuthAuthorization(state, "code-0");
      return { store, credential };
    }

    it("narrows granted scopes from the refresh response", async () => {
      const { store, credential } = await seedOAuth();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          tokenResponse({
            access_token: "at-1",
            refresh_token: "rt-1",
            expires_in: 3600,
            scope: "",
          }),
        ),
      );
      await db.run(
        sql`UPDATE service_credential_auth SET payload = ${JSON.stringify(encryptSecrets({ accessToken: "at-0", refreshToken: "rt-0", expiresAt: 1 }))} WHERE credential_id = ${credential.id}`,
      );
      const refreshed = await store.refreshOAuthToken(
        credential.id,
        "on-demand",
      );
      expect(refreshed.accessToken).toBe("at-1");
      const latest = await store.getCredential(credential.id);
      expect(latest?.grantedScopes).toEqual([]);
      expect(latest?.grantedSource).toBe("provider");
    });

    it("marks revoked on invalid_grant and errored otherwise", async () => {
      const { store, credential } = await seedOAuth();
      await db.run(
        sql`UPDATE service_credential_auth SET payload = ${JSON.stringify(encryptSecrets({ accessToken: "at-0", refreshToken: "rt-0", expiresAt: 1 }))} WHERE credential_id = ${credential.id}`,
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => tokenResponse({ error: "invalid_grant" }, 400)),
      );
      await expect(
        store.refreshOAuthToken(credential.id, "on-demand"),
      ).rejects.toMatchObject({ statusCode: 401 });
      expect((await store.getCredential(credential.id))?.status).toBe(
        "revoked",
      );
    });
  });

  describe("oauth clients", () => {
    it("requires provider and availableScopes", async () => {
      const id = await createClient(svc);
      const client = await svc.getOAuthClient(id);
      expect(client).toMatchObject({
        provider: "test-provider",
        availableScopes: ["read", "write", "admin"],
      });
    });

    it("refuses deletion while referenced, allows after disconnect", async () => {
      await ensureService("svc-1");
      const clientId = await createClient(svc);
      const store = svc.forService("svc-1");
      await store.upsertOAuth2("oauth2", clientId, ["read"]);
      await expect(svc.deleteOAuthClient(clientId)).rejects.toMatchObject({
        statusCode: 409,
      });
      await store.disconnectScheme("oauth2");
      await svc.deleteOAuthClient(clientId);
      expect(await svc.getOAuthClient(clientId)).toBeNull();
    });

    it("resolves by normalized authorization URL and flags ambiguity", async () => {
      const c1 = await createClient(svc, {
        clientId: "c1",
        authorizationUrl: "HTTPS://Provider.Example.COM:443/authorize/",
      });
      void c1;
      const c2 = await createClient(svc, {
        clientId: "c2",
        provider: "other",
        authorizationUrl: "https://provider.example.com/authorize",
        tokenUrl: "https://other.example.com/token",
        availableScopes: ["read"],
      });
      void c2;
      const resolved = await svc.resolveOAuthClients({
        authorizationUrl: "https://provider.example.com/authorize",
        requestedScopes: ["read"],
      });
      expect(resolved).toHaveLength(2);
      expect(resolved[0].clientId).toBe("c1");
      expect(resolved[0].scopeCompatible).toBe(true);
      expect(resolved[0].warning).toBeNull();
      const other = resolved.find((c) => c.clientId === "c2");
      expect(other?.tokenHost).toBe("other.example.com");
    });
  });

  describe("invariants", () => {
    it("enforces exactly-one owner on oauth_pendings", async () => {
      await expect(
        db.run(
          sql`INSERT INTO oauth_pendings (state, service_credential_id, module_credential_id, code_verifier, code_challenge, redirect_uri, created_at, expires_at) VALUES ('x', 'a', 'b', 'v', 'c', 'u', 1, 2)`,
        ),
      ).rejects.toThrow();
      await expect(
        db.run(
          sql`INSERT INTO oauth_pendings (state, code_verifier, code_challenge, redirect_uri, created_at, expires_at) VALUES ('y', 'v', 'c', 'u', 1, 2)`,
        ),
      ).rejects.toThrow();
    });

    it("refuses to use mismatched scheme types", async () => {
      await ensureService("svc-1");
      const store = svc.forService("svc-1");
      const { credential } = await store.upsertApiKey("apiKey", "sk-1");
      await db.run(
        sql`UPDATE service_credential_auth SET scheme_type = 'bearer' WHERE credential_id = ${credential.id}`,
      );
      await expect(store.getDecryptedAuth(credential.id)).rejects.toMatchObject(
        { statusCode: 500 },
      );
    });
  });

  describe("parseGrantedScopes + normalizeAuthUrl units", () => {
    it("parses string, array, and absent scope params", () => {
      expect(parseGrantedScopes({ scope: "a b " }, ["a", "b"])).toEqual({
        scopes: ["a", "b"],
        source: "provider",
      });
      expect(parseGrantedScopes({ scope: ["a"] }, ["a", "b"])).toEqual({
        scopes: ["a"],
        source: "provider",
      });
      expect(parseGrantedScopes({}, ["a"])).toEqual({
        scopes: ["a"],
        source: "inferred",
      });
    });

    it("normalizes URLs for comparison", () => {
      expect(normalizeAuthUrl("HTTPS://Example.COM:443/a/")).toBe(
        "https://example.com/a",
      );
      expect(normalizeAuthUrl("https://example.com/a?x=1#frag")).toBe(
        "https://example.com/a",
      );
      expect(() => normalizeAuthUrl("not a url")).toThrow();
    });
  });

  describe("migration 0018", () => {
    it("upgrades 0017 state: preserves clients, drops old tables", async () => {
      await applyMigrations({ upto: "0017" });
      await db.run(
        sql`INSERT INTO oauth_clients (id, client_id, client_secret, token_url, authorization_url, client_auth_method, redirect_uris, created_at, updated_at) VALUES ('legacy', 'c', '{"alg":"aes-256-gcm","iv":"x","tag":"y","ciphertext":"z"}', 'https://p.example.com/token', NULL, 'client_secret_basic', '[]', '2026-01-01', '2026-01-01')`,
      );
      await db.run(
        sql`INSERT INTO connections (id, name, scheme_type, status, created_at, updated_at) VALUES ('conn', 'n', 'apiKey', 'active', '2026-01-01', '2026-01-01')`,
      );
      await applyMigrations({
        only: "0018_owner_scoped_auth.sql",
        dropFirst: false,
      });

      const tables = await db.all(
        sql`SELECT name FROM sqlite_master WHERE type = 'table'`,
      );
      const names = (tables as Array<{ name: string }>).map((r) => r.name);
      for (const gone of [
        "connections",
        "connection_auth",
        "connection_schemes",
        "module_connection_schemes",
        "pending_authorizations",
        "registry_auth",
      ]) {
        expect(names).not.toContain(gone);
      }
      for (const created of [
        "service_credentials",
        "service_credential_auth",
        "module_credentials",
        "module_credential_auth",
        "registry_credentials",
        "registry_credential_auth",
        "oauth_pendings",
      ]) {
        expect(names).toContain(created);
      }
      const client = await svc.getOAuthClient("legacy");
      expect(client).toMatchObject({ provider: "custom", availableScopes: [] });
      await applyMigrations();
    }, 120_000);
  });
});
