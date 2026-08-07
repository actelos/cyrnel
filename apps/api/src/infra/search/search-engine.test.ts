import fs from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import Database from "libsql";
import { getLoadablePath } from "sqlite-vec";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db, resolveDatabaseUrl } from "@/db/client";
import { services, tools } from "@/db/schema";
import type { Embedder } from "@/infra/embedding/embedder";
import {
  embeddingKey,
  SearchEngine,
  tokenizeQuery,
} from "@/infra/search/search-engine";

const DIMENSIONS = 8;
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../../drizzle");

async function applyMigrations(): Promise<void> {
  await db.run(sql.raw("PRAGMA journal_mode = WAL;"));
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

class FakeEmbedder implements Embedder {
  readonly modelId = "test-model";
  readonly dimensions = DIMENSIONS;
  available: boolean;
  failCount = 0;

  constructor(available = true) {
    this.available = available;
  }

  async init(): Promise<void> {}

  async embed(text: string): Promise<Float32Array> {
    if (this.failCount > 0) {
      this.failCount -= 1;
      throw new Error("embed failure");
    }
    const vector = new Float32Array(this.dimensions);
    for (const word of text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)) {
      let hash = 0;
      for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) | 0;
      vector[Math.abs(hash) % this.dimensions] += 1;
    }
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    }
    return vector;
  }
}

const EMPTY_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

async function ensureAdapter(): Promise<void> {
  await db.run(
    sql`INSERT OR IGNORE INTO modules (id, name, type, description, enabled, missing)
        VALUES ('test-adapter', 'test-adapter', 'adapter', '', 1, 0)`,
  );
}

async function insertTool(
  serviceId: string,
  id: string,
  name: string,
  description = "",
  summary = "",
  enabled = true,
): Promise<void> {
  await ensureAdapter();
  await db.run(
    sql`INSERT OR IGNORE INTO services (id, name, hash, adapter, config_schema, secrets_schema, adapter_domain)
        VALUES (${serviceId}, ${serviceId}, 'hash', 'test-adapter', '{}', '{}', '{}')`,
  );
  await db.insert(tools).values({
    serviceId,
    id,
    name,
    description,
    summary,
    enabled,
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    adapterDomain: {},
  });
}

async function insertService(serviceId: string): Promise<void> {
  await ensureAdapter();
  await db.run(
    sql`INSERT OR IGNORE INTO services (id, name, hash, adapter, config_schema, secrets_schema, adapter_domain)
        VALUES (${serviceId}, ${serviceId}, 'hash', 'test-adapter', '{}', '{}', '{}')`,
  );
}

function openProbe(): Database.Database {
  const probe = new Database(resolveDatabaseUrl());
  probe.defaultSafeIntegers(true);
  probe.loadExtension(getLoadablePath());
  return probe;
}

function embeddingCount(probe: Database.Database): number {
  return Number(
    (
      probe.prepare("SELECT count(*) AS n FROM tool_embeddings").get() as {
        n: number;
      }
    ).n,
  );
}

function embeddingFor(
  probe: Database.Database,
  serviceId: string,
  toolId: string,
): { embedding: string } | undefined {
  return probe
    .prepare(
      "SELECT embedding FROM tool_embeddings WHERE service_id = ? AND tool_id = ?",
    )
    .get(serviceId, toolId) as { embedding: string } | undefined;
}

async function resetDb(): Promise<void> {
  await db.run(sql.raw("DELETE FROM tools"));
  await db.run(sql.raw("DELETE FROM service_secrets"));
  await db.run(sql.raw("DELETE FROM service_configurations"));
  await db.run(sql.raw("DELETE FROM services"));
  await db.run(sql.raw("DELETE FROM module_secrets"));
  await db.run(sql.raw("DELETE FROM module_configurations"));
  await db.run(sql.raw("DELETE FROM modules"));
}

describe("tokenizeQuery", () => {
  it("quotes each token and joins with implicit AND", () => {
    expect(tokenizeQuery('weather-api "test"')).toBe('"weather-api"* "test"*');
    expect(tokenizeQuery("send email")).toBe('"send"* "email"*');
  });

  it("neutralizes FTS5 metacharacters", () => {
    expect(tokenizeQuery("-exclude this")).toBe('"-exclude"* "this"*');
    expect(tokenizeQuery("col:value (paren)")).toBe('"col:value"* "(paren)"*');
    expect(tokenizeQuery('a"b')).toBe('"a""b"*');
  });

  it("skips quote-only and empty tokens", () => {
    expect(tokenizeQuery('"" "')).toBe("");
    expect(tokenizeQuery("   ")).toBe("");
  });

  it("strips a single surrounding quote pair", () => {
    expect(tokenizeQuery('"test"')).toBe('"test"*');
  });
});

describe("SearchEngine (FTS5 + vector hybrid)", () => {
  let search: SearchEngine;
  let embedder: FakeEmbedder;
  let probe: Database.Database;

  beforeAll(async () => {
    await applyMigrations();
    await db.run(sql.raw("PRAGMA foreign_keys = ON"));
    await db.run(
      sql`INSERT INTO modules (id, name, type, description, enabled, missing)
          VALUES ('test-adapter', 'test-adapter', 'adapter', '', 1, 0)`,
    );
    embedder = new FakeEmbedder();
    search = new SearchEngine(embedder);
    await search.init();
    probe = openProbe();
  });

  beforeEach(async () => {
    await resetDb();
    probe.exec("DELETE FROM tool_embeddings");
  });

  afterAll(() => {
    probe?.close();
    search?.close();
  });

  describe("FTS5 trigger sync", () => {
    it("backfills the FTS mirror for tools that predate init", async () => {
      await insertTool("svc", "sendEmail", "sendEmail", "sends email via SMTP");
      const second = new SearchEngine(embedder);
      await second.init();

      const rows = await db.$client.execute({
        sql: "SELECT service_id, tool_id FROM tools_fts WHERE tools_fts MATCH ?",
        args: ["email"],
      });
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].tool_id).toBe("sendEmail");

      const all = await db.$client.execute({
        sql: "SELECT count(*) AS n FROM tools_fts",
      });
      expect(Number(all.rows[0].n)).toBe(1);
      second.close();
    });

    it("mirrors INSERT via triggers", async () => {
      await insertTool("svc", "sendEmail", "sendEmail", "sends email via SMTP");
      const rows = await db.$client.execute({
        sql: "SELECT service_id, tool_id FROM tools_fts WHERE tools_fts MATCH ?",
        args: ["email"],
      });
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].tool_id).toBe("sendEmail");
    });

    it("mirrors UPDATE via triggers", async () => {
      await insertTool("svc", "sendEmail", "sendEmail", "sends email via SMTP");
      await db
        .update(tools)
        .set({ description: "sends email with attachments" })
        .where(sql`${tools.serviceId} = 'svc' AND ${tools.id} = 'sendEmail'`);
      const rows = await db.$client.execute({
        sql: "SELECT tool_id FROM tools_fts WHERE tools_fts MATCH ?",
        args: ["attachments"],
      });
      expect(rows.rows).toHaveLength(1);
      const stale = await db.$client.execute({
        sql: "SELECT tool_id FROM tools_fts WHERE tools_fts MATCH ?",
        args: ["smtp"],
      });
      expect(stale.rows).toHaveLength(0);
    });

    it("mirrors DELETE via triggers", async () => {
      await insertTool("svc", "sendEmail", "sendEmail", "sends email");
      await db
        .delete(tools)
        .where(sql`${tools.serviceId} = 'svc' AND ${tools.id} = 'sendEmail'`);
      const rows = await db.$client.execute({
        sql: "SELECT count(*) AS n FROM tools_fts",
      });
      expect(Number(rows.rows[0].n)).toBe(0);
    });

    it("mirrors FK cascade deletes via triggers", async () => {
      await insertService("svc");
      await insertTool("svc", "sendEmail", "sendEmail", "sends email");
      await db.delete(services).where(sql`${services.id} = 'svc'`);
      const rows = await db.$client.execute({
        sql: "SELECT count(*) AS n FROM tools",
      });
      expect(Number(rows.rows[0].n)).toBe(0);
      const fts = await db.$client.execute({
        sql: "SELECT count(*) AS n FROM tools_fts",
      });
      expect(Number(fts.rows[0].n)).toBe(0);
    });
  });

  describe("searchTools", () => {
    beforeEach(async () => {
      embedder.available = true;
      embedder.failCount = 0;
    });

    it("returns hybrid hits with score and matchType", async () => {
      await insertTool("svc", "sendEmail", "sendEmail", "sends email via SMTP");
      await insertTool("svc", "listUsers", "listUsers", "lists users");
      await search.reindexService("svc");

      const hits = await search.searchTools("email", { limit: 10 });
      expect(hits.length).toBeGreaterThan(0);
      const hit = hits.find((h) => h.toolId === "sendEmail");
      expect(hit).toBeDefined();
      expect(hit?.score).toBeGreaterThan(0);
      expect(hit?.matchType).toBe("both");
      expect(hit?.ftsRank).toBeDefined();
      expect(hit?.vectorRank).toBeDefined();
    });

    it("sorts by fused score and applies limit after fusion", async () => {
      for (let i = 0; i < 10; i++) {
        await insertTool(
          "svc",
          `tool${i}`,
          `tool${i}`,
          `send email message number ${i}`,
        );
      }
      await search.reindexService("svc");

      const hits = await search.searchTools("email message", { limit: 3 });
      expect(hits).toHaveLength(3);
      const scores = hits.map((h) => h.score);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    });

    it("resumes ranked results after an afterKey composite cursor", async () => {
      for (let i = 0; i < 10; i++) {
        await insertTool(
          "svc",
          `tool${i}`,
          `tool${i}`,
          `send email message number ${i}`,
        );
      }
      await search.reindexService("svc");

      const first = await search.searchTools("email message", {
        limit: 4,
      });
      expect(first).toHaveLength(4);

      const last = first[first.length - 1];
      const second = await search.searchTools("email message", {
        limit: 4,
        afterKey: [last.score, last.serviceId, last.toolId],
      });
      expect(second).toHaveLength(4);
      expect(second.every((hit) => hit.score < last.score)).toBe(true);

      const lastSecond = second[second.length - 1];
      const third = await search.searchTools("email message", {
        limit: 4,
        afterKey: [lastSecond.score, lastSecond.serviceId, lastSecond.toolId],
      });
      expect(third.every((hit) => hit.score < lastSecond.score)).toBe(true);

      const ids = new Set([
        ...first.map((h) => h.toolId),
        ...second.map((h) => h.toolId),
        ...third.map((h) => h.toolId),
      ]);
      expect(ids.size).toBe(10);
    });

    it("returns fts-only hits when the vector index has no rows", async () => {
      await insertTool("svc", "sendEmail", "sendEmail", "sends email via SMTP");

      const hits = await search.searchTools("smtp", { limit: 10 });
      expect(hits).toHaveLength(1);
      expect(hits[0].matchType).toBe("fts");
      expect(hits[0].vectorRank).toBeUndefined();
    });

    it("filters by serviceId", async () => {
      await insertTool("svc-a", "sendEmail", "sendEmail", "sends email");
      await insertTool("svc-b", "sendEmail", "sendEmail", "sends email");
      await search.reindexService("svc-a");
      await search.reindexService("svc-b");

      const hits = await search.searchTools("email", {
        serviceId: "svc-a",
        limit: 10,
      });
      expect(hits).toHaveLength(1);
      expect(hits[0].serviceId).toBe("svc-a");
    });

    it("filters by enabled flag", async () => {
      await insertTool(
        "svc",
        "sendEmail",
        "sendEmail",
        "sends email",
        "",
        true,
      );
      await insertTool(
        "svc",
        "listUsers",
        "listUsers",
        "lists users",
        "",
        false,
      );
      await search.reindexService("svc");

      const hits = await search.searchTools("users email", {
        enabled: true,
        limit: 10,
      });
      expect(hits.map((h) => h.toolId).sort()).toEqual(["sendEmail"]);
    });

    it("silently skips vector matches whose tool no longer exists", async () => {
      await insertTool("svc", "sendEmail", "sendEmail", "sends email via SMTP");
      await search.reindexService("svc");

      probe
        .prepare(
          "INSERT INTO tool_embeddings (id, service_id, tool_id, embedding) VALUES (?, ?, ?, ?)",
        )
        .run(embeddingKey("svc", "ghost"), "svc", "ghost", "[1,0,0,0,0,0,0,0]");

      const hits = await search.searchTools("email", { limit: 10 });
      expect(hits.some((h) => h.toolId === "ghost")).toBe(false);
      expect(hits.length).toBeGreaterThan(0);
    });

    it("degrades to FTS5-only for the request when query embedding fails", async () => {
      await insertTool("svc", "sendEmail", "sendEmail", "sends email via SMTP");
      await search.reindexService("svc");
      embedder.failCount = 1;

      const degraded = await search.searchTools("email", { limit: 10 });
      expect(degraded.length).toBeGreaterThan(0);
      expect(degraded.every((h) => h.matchType !== "vector")).toBe(true);

      const healthy = await search.searchTools("email", { limit: 10 });
      expect(healthy.some((h) => h.matchType === "both")).toBe(true);
    });

    it("runs FTS5-only forever when the model is unavailable", async () => {
      embedder.available = false;
      await insertTool("svc", "sendEmail", "sendEmail", "sends email via SMTP");
      await search.reindexService("svc");

      const hits = await search.searchTools("email", { limit: 10 });
      expect(hits).toHaveLength(1);
      expect(hits[0].matchType).toBe("fts");
      expect(search.vectorAvailable).toBe(false);
    });
  });

  describe("reindexService / deleteEmbeddings hooks", () => {
    beforeEach(async () => {
      embedder.available = true;
      embedder.failCount = 0;
    });

    it("regenerates embeddings after a tool update", async () => {
      await insertTool("svc", "sendEmail", "sendEmail", "sends email");
      await search.reindexService("svc");
      const before = embeddingFor(probe, "svc", "sendEmail");
      expect(before).toBeDefined();

      await db
        .update(tools)
        .set({ description: "sends email with attachments" })
        .where(sql`${tools.serviceId} = 'svc' AND ${tools.id} = 'sendEmail'`);
      await search.reindexService("svc");
      const after = embeddingFor(probe, "svc", "sendEmail");
      expect(after).toBeDefined();
      expect(after?.embedding).not.toBe(before?.embedding);
    });

    it("moves the embedding when the tool id changes", async () => {
      await insertTool("svc", "sendEmail", "sendEmail", "sends email");
      await search.reindexService("svc");
      expect(embeddingFor(probe, "svc", "sendEmail")).toBeDefined();

      await db
        .update(tools)
        .set({ id: "sendMail", name: "sendMail" })
        .where(sql`${tools.serviceId} = 'svc' AND ${tools.id} = 'sendEmail'`);
      await search.reindexService("svc");
      expect(embeddingFor(probe, "svc", "sendEmail")).toBeUndefined();
      expect(embeddingFor(probe, "svc", "sendMail")).toBeDefined();
    });

    it("deletes embeddings for a service", async () => {
      await insertTool("svc", "sendEmail", "sendEmail", "sends email");
      await search.reindexService("svc");
      expect(embeddingCount(probe)).toBe(1);

      await search.deleteEmbeddings("svc");
      expect(embeddingCount(probe)).toBe(0);
    });

    it("skips per-tool embedding failures without aborting", async () => {
      await insertTool("svc", "sendEmail", "sendEmail", "sends email");
      await insertTool("svc", "listUsers", "listUsers", "lists users");
      embedder.failCount = 1;
      await search.reindexService("svc");

      const total = embeddingCount(probe);
      expect(total).toBe(1);
      embedder.failCount = 0;
      await search.reindexService("svc");
      expect(embeddingCount(probe)).toBe(2);
    });
  });

  describe("reconcile", () => {
    beforeEach(async () => {
      embedder.available = true;
      embedder.failCount = 0;
    });

    it("embeds tools missing an embedding", async () => {
      await insertTool("svc", "sendEmail", "sendEmail", "sends email");
      const result = await search.reconcile();
      expect(result.embedded).toBe(1);
      expect(embeddingFor(probe, "svc", "sendEmail")).toBeDefined();
    });

    it("deletes orphaned embeddings", async () => {
      probe
        .prepare(
          "INSERT INTO tool_embeddings (id, service_id, tool_id, embedding) VALUES (?, ?, ?, ?)",
        )
        .run(
          embeddingKey("ghost", "gone"),
          "ghost",
          "gone",
          "[1,0,0,0,0,0,0,0]",
        );
      const result = await search.reconcile();
      expect(result.deleted).toBe(1);
      expect(embeddingCount(probe)).toBe(0);
    });

    it("deletes orphans even when the model is unavailable", async () => {
      embedder.available = false;
      probe
        .prepare(
          "INSERT INTO tool_embeddings (id, service_id, tool_id, embedding) VALUES (?, ?, ?, ?)",
        )
        .run(
          embeddingKey("ghost", "gone"),
          "ghost",
          "gone",
          "[1,0,0,0,0,0,0,0]",
        );
      const result = await search.reconcile();
      expect(result.embedded).toBe(0);
      expect(result.deleted).toBe(1);
      embedder.available = true;
    });

    it("skips a failing embed without aborting the batch", async () => {
      await insertTool("svc", "sendEmail", "sendEmail", "sends email");
      await insertTool("svc", "listUsers", "listUsers", "lists users");
      embedder.failCount = 1;
      const result = await search.reconcile();
      expect(result.skipped).toBe(1);
      expect(result.embedded).toBe(1);
      expect(embeddingCount(probe)).toBe(1);
    });
  });

  describe("reconciliation scheduling", () => {
    it("runs on the configured interval", async () => {
      let intervalSearch: SearchEngine | null = null;
      try {
        intervalSearch = new SearchEngine(embedder);
        await intervalSearch.init();
        intervalSearch.startReconciliation(50);

        await insertTool("svc", "sendEmail", "sendEmail", "sends email");
        expect(embeddingFor(probe, "svc", "sendEmail")).toBeUndefined();

        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(embeddingFor(probe, "svc", "sendEmail")).toBeDefined();
      } finally {
        intervalSearch?.close();
      }
    });

    it("disables the interval when given zero", () => {
      const intervalSearch = new SearchEngine(embedder);
      intervalSearch.startReconciliation(0);
      expect(() => intervalSearch.close()).not.toThrow();
    });
  });
});
