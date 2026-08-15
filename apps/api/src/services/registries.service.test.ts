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
import { registries } from "@/db/schema";
import { HttpError } from "@/models/error.model";
import { RegistriesService } from "@/services/registries.service";
import { encodeCursor } from "@/utils/pagination.util";

vi.mock("@/utils/download.util", () => ({
  assertRegistryAddressAllowed: vi.fn(async () => undefined),
}));

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../drizzle");

async function applyMigrations(): Promise<void> {
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
