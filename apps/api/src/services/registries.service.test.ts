import fs from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db/client";
import { registries } from "@/db/schema";
import { HttpError } from "@/models/error.model";
import { RegistriesService } from "@/services/registries.service";
import { encodeCursor } from "@/utils/pagination.util";

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
