import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
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
import { modules, services } from "@/db/schema";
import {
  parseAuthRefreshInterval,
  sweepExpiredPendingAuthorizations,
  sweepExpiringOAuthTokens,
} from "@/services/auth.sweeper";
import { CredentialService } from "@/services/credential.service";
import { encryptSecrets } from "@/utils/secrets.util";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../drizzle");

const SECRETS_KEY = crypto.randomBytes(32).toString("base64");
const originalSecretsKey = process.env.CYRNEL_SECRETS_KEY;
const originalPreviousKeys = process.env.CYRNEL_SECRETS_PREVIOUS_KEYS;

async function applyMigrations(): Promise<void> {
  const existing = await db.all(
    sql.raw(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='service_credentials'",
    ),
  );
  if (existing.length > 0) return;
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
  ]) {
    await db.run(sql.raw(`DELETE FROM ${name}`));
  }
  await db.run(sql.raw("PRAGMA foreign_keys = ON"));
}

const svc = new CredentialService();

const OAUTH_SCHEMES = {
  oauth2: {
    type: "oauth2",
    grantTypes: ["authorizationCode"],
    authorizationUrl: "https://provider.example.com/authorize",
    tokenUrl: "https://provider.example.com/token",
    scopes: { read: "Read access" },
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
      schemes: OAUTH_SCHEMES,
    })
    .onConflictDoNothing();
}

async function seedOAuthCredential(
  serviceId: string,
  expiresAt: number,
): Promise<string> {
  await ensureService(serviceId);
  const clientId = await svc.createOAuthClient({
    provider: "test-provider",
    clientId: `c-${serviceId}-${Date.now()}-${Math.random()}`,
    clientSecret: "shh",
    tokenUrl: "https://provider.example.com/token",
    authorizationUrl: "https://provider.example.com/authorize",
    availableScopes: ["read"],
  });
  const { credential } = await svc
    .forService(serviceId)
    .upsertOAuth2("oauth2", clientId, ["read"]);
  await db.run(
    sql`UPDATE service_credential_auth SET payload = ${JSON.stringify(encryptSecrets({ accessToken: "old", refreshToken: "rt", expiresAt }))} WHERE credential_id = ${credential.id}`,
  );
  return credential.id;
}

describe("auth-sweeper", () => {
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("sweepExpiredPendingAuthorizations()", () => {
    it("prunes only expired rows", async () => {
      await ensureService("svc-1");
      const clientId = await svc.createOAuthClient({
        provider: "test-provider",
        clientId: "c",
        clientSecret: "s",
        tokenUrl: "https://provider.example.com/token",
        authorizationUrl: "https://provider.example.com/authorize",
        availableScopes: [],
      });
      const store = svc.forService("svc-1");
      await store.upsertOAuth2("oauth2", clientId, []);
      const first = await store.beginOAuth("oauth2");
      await store.beginOAuth("oauth2");
      await db.run(
        sql`UPDATE oauth_pendings SET expires_at = 1 WHERE state = ${first.state}`,
      );

      expect(await sweepExpiredPendingAuthorizations()).toBe(1);

      const remaining = await db.all(sql`SELECT state FROM oauth_pendings`);
      expect(remaining).toHaveLength(1);
    });
  });

  describe("sweepExpiringOAuthTokens()", () => {
    it("refreshes tokens within the horizon and skips fresh ones", async () => {
      const expiring = await seedOAuthCredential("svc-1", Date.now() + 60_000);
      await seedOAuthCredential("svc-2", Date.now() + 24 * 3600_000);

      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ access_token: "new", expires_in: 3600 }),
            {
              status: 200,
            },
          ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const stats = await sweepExpiringOAuthTokens(300_000, svc);
      expect(stats).toMatchObject({ checked: 2, refreshed: 1, failed: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        await svc.forService("svc-1").getDecryptedAuth(expiring),
      ).toMatchObject({
        accessToken: "new",
      });
    });

    it("skips tokens without a refresh token", async () => {
      await ensureService("svc-1");
      const clientId = await svc.createOAuthClient({
        provider: "test-provider",
        clientId: "c-nort",
        clientSecret: "s",
        tokenUrl: "https://provider.example.com/token",
        authorizationUrl: "https://provider.example.com/authorize",
        availableScopes: [],
      });
      const { credential } = await svc
        .forService("svc-1")
        .upsertOAuth2("oauth2", clientId, []);
      await db.run(
        sql`UPDATE service_credential_auth SET payload = ${JSON.stringify(encryptSecrets({ accessToken: "old", expiresAt: Date.now() - 1000 }))} WHERE credential_id = ${credential.id}`,
      );

      const fetchMock = vi.fn(async () => {
        throw new Error("must not be called");
      });
      vi.stubGlobal("fetch", fetchMock);

      const stats = await sweepExpiringOAuthTokens(300_000, svc);
      expect(stats).toMatchObject({ checked: 0, refreshed: 0, failed: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("parseAuthRefreshInterval()", () => {
    it("defaults to 5 minutes when unset", () => {
      expect(parseAuthRefreshInterval(undefined)).toBe(300_000);
    });

    it("accepts 0 as disabled", () => {
      expect(parseAuthRefreshInterval("0")).toBe(0);
    });

    it("falls back to default on invalid values", () => {
      expect(parseAuthRefreshInterval("-1")).toBe(300_000);
      expect(parseAuthRefreshInterval("nope")).toBe(300_000);
      expect(parseAuthRefreshInterval("2147483648")).toBe(300_000);
    });

    it("accepts valid values", () => {
      expect(parseAuthRefreshInterval("60000")).toBe(60_000);
    });
  });
});
