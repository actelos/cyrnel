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
import { modules, registries, services } from "@/db/schema";
import {
  HostCredentialProvider,
  ModuleCredentialProvider,
  RegistryCredentialProvider,
} from "@/services/credential.provider";
import { CredentialService } from "@/services/credential.service";
import { CredentialUnavailable } from "@/services/providers";
import { encryptSecrets } from "@/utils/secrets.util";

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
  await db.insert(services).values({
    id,
    name: id,
    hash: "h",
    adapter: "test-adapter",
    configSchema: { type: "object" },
    secretsSchema: { type: "object" },
    adapterDomain: {},
    schemes: {
      apiKey: { type: "apiKey", in: "header", paramName: "X-API-Key" },
      basic: { type: "http", scheme: "basic" },
      bearer: { type: "http", scheme: "bearer" },
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
    },
  });
}

async function seedOAuthCredential(
  svc: CredentialService,
  owner: "service" | "module",
  ownerId: string,
  scheme: string,
  token: Record<string, unknown>,
  scopes: string[] = ["read"],
): Promise<string> {
  const clientId = await svc.createOAuthClient({
    provider: "test-provider",
    clientId: `c-${ownerId}-${scheme}`,
    clientSecret: "s",
    tokenUrl: "https://provider.example.com/token",
    authorizationUrl: "https://provider.example.com/authorize",
    availableScopes: ["read", "write"],
  });
  const store =
    owner === "service" ? svc.forService(ownerId) : svc.forModule(ownerId);
  const { credential } = await store.upsertOAuth2(scheme, clientId, scopes);
  const authTable =
    owner === "service" ? "service_credential_auth" : "module_credential_auth";
  await db.run(
    sql`UPDATE ${sql.raw(authTable)} SET payload = ${JSON.stringify(encryptSecrets(token))} WHERE credential_id = ${credential.id}`,
  );
  await db.run(
    sql`UPDATE ${sql.raw(owner === "service" ? "service_credentials" : "module_credentials")} SET granted_scopes = '["read"]', granted_source = 'provider' WHERE id = ${credential.id}`,
  );
  return credential.id;
}

const svc = new CredentialService();

describe("HostCredentialProvider", () => {
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

  it("throws CredentialUnavailable when no credential is configured", async () => {
    const provider = new HostCredentialProvider("svc-1");
    const err = await provider.getCredential("apiKey").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CredentialUnavailable);
    expect((err as { message: string }).message).toContain(
      "No credential is available",
    );
  });

  it("resolves apiKey credentials", async () => {
    await ensureService("svc-1");
    await svc.forService("svc-1").upsertApiKey("apiKey", "sk-1");

    const cred = await new HostCredentialProvider("svc-1").getCredential(
      "apiKey",
    );
    expect(cred).toEqual({ type: "apiKey", value: "sk-1" });
  });

  it("resolves basic credentials", async () => {
    await ensureService("svc-1");
    await svc.forService("svc-1").upsertBasic("basic", "u", "p");

    const cred = await new HostCredentialProvider("svc-1").getCredential(
      "basic",
    );
    expect(cred).toEqual({ type: "basic", username: "u", password: "p" });
  });

  it("resolves bearer credentials", async () => {
    await ensureService("svc-1");
    await svc.forService("svc-1").upsertBearer("bearer", "tok-1");

    const cred = await new HostCredentialProvider("svc-1").getCredential(
      "bearer",
    );
    expect(cred).toEqual({ type: "bearer", token: "tok-1" });
  });

  it("returns a fresh oauth2 token with granted scopes without refreshing", async () => {
    await ensureService("svc-1");
    await seedOAuthCredential(svc, "service", "svc-1", "oauth2", {
      accessToken: "fresh",
      refreshToken: "rt",
      expiresAt: Date.now() + 3600_000,
    });

    const fetchMock = vi.fn(async () => {
      throw new Error("must not be called");
    });
    vi.stubGlobal("fetch", fetchMock);

    const cred = await new HostCredentialProvider("svc-1").getCredential(
      "oauth2",
    );
    expect(cred).toMatchObject({
      type: "oauth2",
      accessToken: "fresh",
      scopes: ["read"],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an expiring oauth2 token on demand", async () => {
    await ensureService("svc-1");
    await seedOAuthCredential(svc, "service", "svc-1", "oauth2", {
      accessToken: "stale",
      refreshToken: "rt",
      expiresAt: Date.now() + 1000,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ access_token: "new", expires_in: 3600 }),
            { status: 200 },
          ),
      ),
    );

    const cred = await new HostCredentialProvider("svc-1").getCredential(
      "oauth2",
    );
    expect(cred).toMatchObject({ type: "oauth2", accessToken: "new" });
  });

  it("fails expired oauth2 tokens without a refresh token and marks them expired", async () => {
    await ensureService("svc-1");
    const id = await seedOAuthCredential(svc, "service", "svc-1", "oauth2", {
      accessToken: "stale",
      expiresAt: Date.now() - 1000,
    });

    await expect(
      new HostCredentialProvider("svc-1").getCredential("oauth2"),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await svc.forService("svc-1").getCredential(id)).toMatchObject({
      status: "expired",
    });
  });

  it("refuses revoked credentials", async () => {
    await ensureService("svc-1");
    const { credential } = await svc
      .forService("svc-1")
      .upsertApiKey("apiKey", "sk-1");
    await svc.forService("svc-1").setStatus(credential.id, "revoked");

    await expect(
      new HostCredentialProvider("svc-1").getCredential("apiKey"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("ModuleCredentialProvider", () => {
  beforeAll(async () => {
    process.env.CYRNEL_SECRETS_KEY = SECRETS_KEY;
    delete process.env.CYRNEL_SECRETS_PREVIOUS_KEYS;
  });

  beforeEach(async () => {
    await resetDb();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function ensureModule(id: string): Promise<void> {
    await db
      .insert(modules)
      .values({
        id,
        name: id,
        type: "adapter",
        description: "",
        hash: "h",
        version: "0.0.0",
        source: "",
        schemes: {
          modKey: { type: "apiKey", in: "header", paramName: "X-Api-Key" },
          demoOAuth: {
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
        },
        security: [],
      })
      .onConflictDoNothing();
  }

  it("throws CredentialUnavailable naming the module when unconfigured", async () => {
    await ensureModule("mod-1");
    const err = await new ModuleCredentialProvider("mod-1")
      .getCredential("demoOAuth")
      .then(
        () => {
          throw new Error("should have thrown");
        },
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(CredentialUnavailable);
    expect((err as Error).message).toContain("module 'mod-1'");
  });

  it("resolves a credential configured for a module scheme", async () => {
    await ensureModule("mod-1");
    await svc.forModule("mod-1").upsertApiKey("modKey", "sk-1");

    await expect(
      new ModuleCredentialProvider("mod-1").getCredential("modKey"),
    ).resolves.toEqual({ type: "apiKey", value: "sk-1" });
  });

  it("resolves an oauth2 token with granted scopes for a module scheme", async () => {
    await ensureModule("mod-1");
    await seedOAuthCredential(svc, "module", "mod-1", "demoOAuth", {
      accessToken: "tok",
      refreshToken: "rt",
      expiresAt: Date.now() + 3600_000,
    });

    await expect(
      new ModuleCredentialProvider("mod-1").getCredential("demoOAuth"),
    ).resolves.toMatchObject({
      type: "oauth2",
      accessToken: "tok",
      scopes: ["read"],
    });
  });
});

describe("RegistryCredentialProvider", () => {
  beforeAll(async () => {
    process.env.CYRNEL_SECRETS_KEY = SECRETS_KEY;
    delete process.env.CYRNEL_SECRETS_PREVIOUS_KEYS;
  });

  beforeEach(async () => {
    await resetDb();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws CredentialUnavailable for registries without credentials", async () => {
    await db.insert(registries).values({
      id: "reg-1",
      baseUrl: "https://reg.example.com/",
      lastSyncedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const err = await new RegistryCredentialProvider("reg-1")
      .getCredential("apiKey")
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(CredentialUnavailable);
  });
});
