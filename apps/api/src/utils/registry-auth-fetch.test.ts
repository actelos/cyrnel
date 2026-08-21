import crypto from "node:crypto";
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
import { registries, registryAuth } from "@/db/schema";
import { downloadBinary } from "@/utils/download.util";
import {
  fetchWithRegistryAuth,
  headersForUrl,
  invalidateRegistryAuthCache,
} from "@/utils/registry-auth.util";
import { encryptSecrets } from "@/utils/secrets.util";

if (!process.env.CYRNEL_SECRETS_KEY) {
  process.env.CYRNEL_SECRETS_KEY = crypto.randomBytes(32).toString("base64");
}

function mockFetch(fn: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fn);
  return fn;
}

const { lookupMock } = vi.hoisted(() => {
  const lookupMock = vi.fn(async (host: string) => {
    switch (host) {
      case "loopback.example.com":
        return [{ address: "127.0.0.1", family: 4 }];
      case "public.example.com":
        return [{ address: "93.184.216.34", family: 4 }];
      default:
        return [{ address: "93.184.216.34", family: 4 }];
    }
  });
  return { lookupMock };
});

vi.mock("node:dns/promises", () => ({ default: { lookup: lookupMock } }));

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../drizzle");

async function applyMigrations(): Promise<void> {
  const existing = await db.run(
    sql.raw(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='registries'",
    ),
  );
  if (existing.rows.length > 0) return;
  const fs = await import("node:fs/promises");
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
  await db.run(sql.raw("DELETE FROM registry_auth"));
  await db.run(sql.raw("DELETE FROM registries"));
  await db.run(sql.raw("PRAGMA foreign_keys = ON"));
}

beforeAll(async () => {
  await applyMigrations();
});

afterAll(async () => {
  await resetDb();
});

async function seedApiKeyRegistry(
  id: string,
  baseUrl: string,
  apiKey: string,
  headerName: string,
): Promise<void> {
  await db.insert(registries).values({
    id,
    baseUrl,
    lastSyncedAt: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
  await db.insert(registryAuth).values({
    registryId: id,
    authType: "apiKey",
    config: encryptSecrets({ apiKey }),
    headerName,
    updatedAt: Date.now(),
  });
  invalidateRegistryAuthCache();
}

async function seedOauthRegistry(
  id: string,
  baseUrl: string,
  tokenEndpoint: string,
  accessToken: string,
  expiresAt: number,
): Promise<void> {
  await db.insert(registries).values({
    id,
    baseUrl,
    lastSyncedAt: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
  await db.insert(registryAuth).values({
    registryId: id,
    authType: "oauth2",
    config: encryptSecrets({ clientId: "c", clientSecret: "s" }),
    tokenEndpoint,
    token: encryptSecrets({
      accessToken,
      expiresAt,
    }),
    tokenExpiresAt: expiresAt,
    updatedAt: Date.now(),
  });
  invalidateRegistryAuthCache();
}

describe("headersForUrl", () => {
  beforeEach(async () => {
    await resetDb();
    invalidateRegistryAuthCache();
  });

  it("attaches the api key header for a same-origin https URL", async () => {
    await seedApiKeyRegistry(
      "r1",
      "https://reg.example.com",
      "secret",
      "X-Key",
    );
    const headers = await headersForUrl(
      "https://reg.example.com/definitions/v1",
    );
    expect(headers?.headers["X-Key"]).toBe("secret");
  });

  it("returns null for a cross-origin URL (strips auth)", async () => {
    await seedApiKeyRegistry(
      "r1",
      "https://reg.example.com",
      "secret",
      "X-Key",
    );
    const headers = await headersForUrl("https://other.example.com/x");
    expect(headers).toBeNull();
  });

  it("throws refusing to send credentials over plaintext http to a public host", async () => {
    await seedApiKeyRegistry(
      "r2",
      "http://public.example.com",
      "secret",
      "X-Key",
    );
    await expect(
      headersForUrl("http://public.example.com/x"),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it("allows plaintext http when the host resolves to loopback", async () => {
    await seedApiKeyRegistry(
      "r3",
      "http://loopback.example.com",
      "secret",
      "X-Key",
    );
    const headers = await headersForUrl("http://loopback.example.com/x");
    expect(headers?.headers["X-Key"]).toBe("secret");
  });
});

describe("fetchWithRegistryAuth", () => {
  beforeEach(async () => {
    await resetDb();
    invalidateRegistryAuthCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("attaches the api key header on a same-origin request", async () => {
    await seedApiKeyRegistry(
      "r1",
      "https://reg.example.com",
      "secret",
      "X-Key",
    );
    const fetchMock = mockFetch(
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    await fetchWithRegistryAuth("https://reg.example.com/definitions/v1");
    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { headers?: Record<string, string> },
    ];
    expect(init.headers?.["X-Key"]).toBe("secret");
  });

  it("strips auth on a cross-origin request", async () => {
    await seedApiKeyRegistry(
      "r1",
      "https://reg.example.com",
      "secret",
      "X-Key",
    );
    const fetchMock = mockFetch(
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    await fetchWithRegistryAuth("https://other.example.com/x");
    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { headers?: Record<string, string> },
    ];
    expect(init.headers?.["X-Key"]).toBeUndefined();
  });

  it("retries exactly once with a fresh token after a 401 (oauth2)", async () => {
    await seedOauthRegistry(
      "o1",
      "https://reg.example.com",
      "https://reg.example.com/token",
      "tok",
      Date.now() + 100_000,
    );

    let resourceCalls = 0;
    const fetchMock = mockFetch(
      vi.fn(async (input: string) => {
        const url = new URL(String(input));
        if (url.pathname === "/token") {
          return new Response(
            JSON.stringify({ access_token: "refreshed", expires_in: 3600 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        resourceCalls += 1;
        if (resourceCalls === 1) {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response("{}", { status: 200 });
      }),
    );

    const result = await fetchWithRegistryAuth(
      "https://reg.example.com/resource",
    );
    expect(result.response.status).toBe(200);

    const resourceUrls = fetchMock.mock.calls
      .map(([u]) => String(u))
      .filter((u) => u.includes("/resource"));
    expect(resourceUrls).toHaveLength(2);

    const resourceCallsWithAuth = fetchMock.mock.calls.filter(
      ([u, init]) =>
        String(u).includes("/resource") &&
        Boolean(init?.headers?.authorization),
    );
    expect(resourceCallsWithAuth).toHaveLength(2);
  });
});

describe("download registry auth integration (downloadBinary)", () => {
  beforeEach(async () => {
    await resetDb();
    invalidateRegistryAuthCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
  });

  it("attaches the api key header on a same-origin download", async () => {
    await seedApiKeyRegistry(
      "r1",
      "https://reg.example.com",
      "secret",
      "X-Key",
    );
    const fetchMock = mockFetch(
      vi.fn(async () => new Response("{}", { status: 200 })),
    );

    await downloadBinary("https://reg.example.com/file", 1_000_000, "test");

    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).includes("/file"),
    ) as [string, { headers?: Record<string, string> }];
    expect(call?.[1].headers?.["X-Key"]).toBe("secret");
  });

  it("strips auth on a cross-origin download", async () => {
    await seedApiKeyRegistry(
      "r1",
      "https://reg.example.com",
      "secret",
      "X-Key",
    );
    const fetchMock = mockFetch(
      vi.fn(async () => new Response("{}", { status: 200 })),
    );

    await downloadBinary("https://other.example.com/file", 1_000_000, "test");

    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).includes("/file"),
    ) as [string, { headers?: Record<string, string> }];
    expect(call?.[1].headers?.["X-Key"]).toBeUndefined();
  });
});
