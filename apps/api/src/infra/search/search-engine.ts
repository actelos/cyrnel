import { asc, eq, sql } from "drizzle-orm";
import Database from "libsql";
import { getLoadablePath } from "sqlite-vec";

import { db, resolveDatabaseUrl } from "@/db/client";
import { tools } from "@/db/schema";
import type { Embedder } from "@/infra/embedding/embedder";
import { logger } from "@/infra/logging";
import {
  embeddingsStatement,
  FTS5_BACKFILL,
  FTS5_BACKFILL_CLEAR,
  FTS5_STATEMENTS,
  TOOL_EMBEDDINGS_METADATA_STATEMENT,
  TOOL_EMBEDDINGS_METADATA_TABLE,
  TOOL_EMBEDDINGS_TABLE,
  TOOLS_FTS_TABLE,
} from "@/infra/search/search-schema";

const RRF_K = 60;
const CANDIDATE_CAP_FACTOR = 5;
const CANDIDATE_CAP_MIN = 100;
const RECONCILE_BATCH_SIZE = 50;
const IN_CHUNK_SIZE = 250;
const SEARCH_DB_TIMEOUT_MS = 5_000;

export type MatchType = "fts" | "vector" | "both";

export interface HybridToolHit {
  serviceId: string;
  toolId: string;
  name: string;
  summary: string;
  description: string;
  enabled: boolean;
  score: number;
  matchType: MatchType;
  ftsRank?: number;
  vectorRank?: number;
}

export interface SearchOptions {
  serviceId?: string;
  enabled?: boolean;
  limit: number;
  /**
   * Opaque-cursor continuation key `[score, serviceId, toolId]`: resume the
   * ranked result list strictly after this hit. Search results are sorted by
   * RRF score descending, so the cursor must carry the score boundary of the
   * last served hit — a bare `(serviceId, toolId)` key cannot slice a
   * score-ordered list (equal-score ties are broken by composite key).
   */
  afterKey?: [score: number, serviceId: string, toolId: string];
}

export interface ReconcileResult {
  embedded: number;
  deleted: number;
  skipped: number;
}

export interface SearchIndex {
  init(): Promise<void>;
  readonly vectorAvailable: boolean;
  searchTools(query: string, options: SearchOptions): Promise<HybridToolHit[]>;
  reindexService(serviceId: string): Promise<void>;
  deleteEmbeddings(serviceId: string): Promise<void>;
  reconcile(): Promise<ReconcileResult>;
  reconcileGuarded(): Promise<void>;
  startReconciliation(intervalMs: number): void;
  close(): void;
}

function toolKey(serviceId: string, toolId: string): string {
  return `${serviceId}\u0000${toolId}`;
}

/**
 * Stable 63-bit FNV-1a hash of the composite tool key. Used as the vec0
 * integer primary key (sqlite-vec requires integer keys, and JS `number`
 * binds come through as REAL which sqlite-vec rejects; BigInt binds as
 * INTEGER). Collisions are astronomically unlikely at Cyrnel's scale, but
 * this is a best-effort key, not a uniqueness guarantee the way an
 * autoincrement would be.
 */
export function embeddingKey(serviceId: string, toolId: string): bigint {
  const input = `${serviceId}\u0000${toolId}`;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return (hash >> 1n) & 0x7fffffffffffffffn;
}

export function embeddingText(
  serviceId: string,
  toolId: string,
  name: string,
  description: string,
  summary: string,
): string {
  return `${serviceId}: ${toolId}: ${name}: ${description}: ${summary}`;
}

function jsonVector(vector: ArrayLike<number>): string {
  return `[${Array.from(vector).join(",")}]`;
}

/**
 * Build a safe FTS5 MATCH expression from free-form user input. Raw queries
 * are never passed to MATCH: each token is wrapped in a double-quoted phrase
 * (embedded quotes doubled, a single surrounding quote pair stripped) and
 * suffixed with `*` for prefix matching, then joined with spaces for FTS5's
 * implicit AND. This neutralizes FTS5 syntax metacharacters (unbalanced
 * parens, colons, leading hyphens/NOT, dangling quotes).
 */
export function tokenizeQuery(query: string): string {
  const tokens: string[] = [];
  for (const raw of query.split(/\s+/)) {
    let token = raw;
    if (token.startsWith('"') && token.endsWith('"') && token.length >= 2) {
      token = token.slice(1, -1);
    }
    const escaped = token.replaceAll('"', '""');
    if (escaped.length === 0 || !/[^"]/.test(escaped)) continue;
    tokens.push(`"${escaped}"*`);
  }
  return tokens.join(" ");
}

type ToolSearchRow = {
  service_id: string;
  id: string;
  name: string;
  summary: string;
  description: string;
  enabled: number;
};

type EmbeddingRef = { service_id: string; tool_id: string };

export class SearchEngine implements SearchIndex {
  private searchDb: Database.Database | null = null;
  private schemaReady = false;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconciling = false;

  constructor(
    private readonly embedder: Embedder,
    private readonly appDb: typeof db = db,
  ) {}

  get vectorAvailable(): boolean {
    return this.schemaReady && this.embedder.available;
  }

  async init(): Promise<void> {
    for (const statement of FTS5_STATEMENTS) {
      await this.appDb.run(sql.raw(statement));
    }
    await this.appDb.run(sql.raw(TOOL_EMBEDDINGS_METADATA_STATEMENT));
    await this.appDb.run(sql.raw(FTS5_BACKFILL_CLEAR));
    await this.appDb.run(sql.raw(FTS5_BACKFILL));
    try {
      this.searchDb = new Database(resolveDatabaseUrl(), {
        timeout: SEARCH_DB_TIMEOUT_MS,
      });
      this.searchDb.defaultSafeIntegers(true);
      this.searchDb.exec("PRAGMA journal_mode = WAL;");
      this.searchDb.loadExtension(getLoadablePath());
      const metadata = await this.appDb.$client.execute({
        sql: `SELECT embedding_model, embedding_dimensions FROM ${TOOL_EMBEDDINGS_METADATA_TABLE} WHERE id = 1`,
      });
      const recorded = metadata.rows[0]
        ? {
            embedding_model: String(metadata.rows[0].embedding_model),
            embedding_dimensions: Number(metadata.rows[0].embedding_dimensions),
          }
        : null;
      const needsRebuild =
        recorded === null ||
        recorded.embedding_model !== this.embedder.modelId ||
        recorded.embedding_dimensions !== this.embedder.dimensions;
      if (needsRebuild) {
        this.searchDb.exec(`DROP TABLE IF EXISTS ${TOOL_EMBEDDINGS_TABLE}`);
      }
      this.searchDb.exec(embeddingsStatement(this.embedder.dimensions));
      if (needsRebuild) {
        await this.appDb.run(sql`
          INSERT INTO ${sql.raw(TOOL_EMBEDDINGS_METADATA_TABLE)} (id, embedding_model, embedding_dimensions)
          VALUES (1, ${this.embedder.modelId}, ${this.embedder.dimensions})
          ON CONFLICT(id) DO UPDATE SET
            embedding_model = excluded.embedding_model,
            embedding_dimensions = excluded.embedding_dimensions
        `);
      }
      this.schemaReady = true;
    } catch (err) {
      this.searchDb?.close();
      this.searchDb = null;
      logger.warn(
        { event: "vector-search-unavailable", err },
        "Vector search unavailable; running in FTS5-only mode",
      );
    }
    // Model load is awaited so the first reconciliation sweep can index
    // vectors immediately instead of deferring until the next timer tick.
    await this.embedder.init();
  }

  close(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.searchDb?.close();
    this.searchDb = null;
    this.schemaReady = false;
  }

  startReconciliation(intervalMs: number): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (intervalMs <= 0) return;
    this.reconcileTimer = setInterval(() => {
      if (this.reconciling) {
        logger.debug(
          { event: "reconcile-skipped" },
          "Skipping search reconciliation: previous run still in flight",
        );
        return;
      }
      void this.reconcileGuarded();
    }, intervalMs);
    this.reconcileTimer.unref();
  }

  async reconcileGuarded(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      await this.reconcile();
    } catch (err) {
      logger.error(
        { event: "reconcile-failed", err },
        "Search reconciliation failed",
      );
    } finally {
      this.reconciling = false;
    }
  }

  async searchTools(
    query: string,
    options: SearchOptions,
  ): Promise<HybridToolHit[]> {
    const cap = Math.max(
      options.limit * CANDIDATE_CAP_FACTOR,
      CANDIDATE_CAP_MIN,
    );
    const match = tokenizeQuery(query);

    const [ftsKeys, vecKeys] = await Promise.all([
      this.queryFts(match, cap, options.serviceId),
      this.queryVector(query, cap, options.serviceId),
    ]);

    const keys = [...new Set([...ftsKeys, ...vecKeys])];
    const toolsByKey = await this.resolveTools(keys, options);

    const hits = new Map<
      string,
      {
        tool: ToolSearchRow;
        ftsRank?: number;
        vectorRank?: number;
      }
    >();
    ftsKeys.forEach((key, index) => {
      const tool = toolsByKey.get(key);
      if (!tool) return;
      hits.set(key, { tool, ftsRank: index + 1 });
    });
    vecKeys.forEach((key, index) => {
      const tool = toolsByKey.get(key);
      if (!tool) return;
      const hit = hits.get(key);
      if (hit) {
        hit.vectorRank = index + 1;
      } else {
        hits.set(key, { tool, vectorRank: index + 1 });
      }
    });

    const results = [...hits.values()].map(({ tool, ftsRank, vectorRank }) => {
      const score =
        (ftsRank !== undefined ? 1 / (RRF_K + ftsRank) : 0) +
        (vectorRank !== undefined ? 1 / (RRF_K + vectorRank) : 0);
      const matchType: MatchType =
        ftsRank !== undefined && vectorRank !== undefined
          ? "both"
          : ftsRank !== undefined
            ? "fts"
            : "vector";
      return {
        serviceId: tool.service_id,
        toolId: tool.id,
        name: tool.name,
        summary: tool.summary,
        description: tool.description,
        enabled: tool.enabled === 1,
        score,
        matchType,
        ...(ftsRank !== undefined ? { ftsRank } : {}),
        ...(vectorRank !== undefined ? { vectorRank } : {}),
      };
    });

    results.sort(
      (a, b) =>
        b.score - a.score ||
        a.serviceId.localeCompare(b.serviceId) ||
        a.toolId.localeCompare(b.toolId),
    );
    if (options.afterKey !== undefined) {
      const [afterScore, afterServiceId, afterToolId] = options.afterKey;
      return results
        .filter(
          (hit) =>
            hit.score < afterScore ||
            (hit.score === afterScore &&
              (hit.serviceId > afterServiceId ||
                (hit.serviceId === afterServiceId &&
                  hit.toolId > afterToolId))),
        )
        .slice(0, options.limit);
    }
    return results.slice(0, options.limit);
  }

  /**
   * Regenerate the embeddings of every tool of a service. Called after the
   * service's tool set is created/replaced; embeddings are derived data, so
   * this is not part of the tools transaction (the search connection cannot
   * join it), and a crash in between is healed by reconciliation.
   */
  async reindexService(serviceId: string): Promise<void> {
    if (!this.vectorAvailable || !this.searchDb) return;
    const rows = await this.appDb
      .select({
        service_id: tools.serviceId,
        id: tools.id,
        name: tools.name,
        summary: tools.summary,
        description: tools.description,
      })
      .from(tools)
      .orderBy(asc(tools.serviceId), asc(tools.id))
      .where(eq(tools.serviceId, serviceId));

    const embeddedRows: Array<{
      serviceId: string;
      toolId: string;
      vector: Float32Array;
    }> = [];
    let anySucceeded = false;

    for (let i = 0; i < rows.length; i += RECONCILE_BATCH_SIZE) {
      const batch = rows.slice(i, i + RECONCILE_BATCH_SIZE);
      const settled = await Promise.allSettled(
        batch.map(async (row) => ({
          serviceId: row.service_id,
          toolId: row.id,
          vector: await this.embedder.embed(
            embeddingText(
              row.service_id,
              row.id,
              row.name,
              row.description,
              row.summary,
            ),
          ),
        })),
      );

      for (const result of settled) {
        if (result.status === "rejected") {
          logger.warn(
            {
              event: "reindex-embed-failed",
              err: result.reason,
              serviceId,
            },
            "Failed to embed tool during reindex; skipping",
          );
          continue;
        }
        anySucceeded = true;
        embeddedRows.push(result.value);
      }
    }

    if (!anySucceeded) return;

    const db = this.searchDb;
    const run = db.transaction(() => {
      db.prepare(
        `DELETE FROM ${TOOL_EMBEDDINGS_TABLE} WHERE service_id = ?`,
      ).run(serviceId);
      for (const row of embeddedRows) {
        this.insertEmbeddingRow(db, row.serviceId, row.toolId, row.vector);
      }
    });
    run();
  }

  async deleteEmbeddings(serviceId: string): Promise<void> {
    if (!this.schemaReady || !this.searchDb) return;
    this.searchDb
      .prepare(`DELETE FROM ${TOOL_EMBEDDINGS_TABLE} WHERE service_id = ?`)
      .run(serviceId);
  }

  /**
   * Bring the search index back in line with the `tools` table: embed tools
   * that have no embedding and delete embeddings whose tool no longer
   * exists. Batched; a single failing embed logs and is skipped rather than
   * aborting the run.
   */
  async reconcile(): Promise<ReconcileResult> {
    const result: ReconcileResult = { embedded: 0, deleted: 0, skipped: 0 };
    if (!this.schemaReady || !this.searchDb) return result;

    if (this.vectorAvailable) {
      let offset = 0;
      while (true) {
        const batch = await this.appDb
          .select({
            service_id: tools.serviceId,
            id: tools.id,
            name: tools.name,
            summary: tools.summary,
            description: tools.description,
          })
          .from(tools)
          .orderBy(asc(tools.serviceId), asc(tools.id))
          .limit(RECONCILE_BATCH_SIZE)
          .offset(offset);
        if (batch.length === 0) break;
        offset += batch.length;

        const existing = await this.embeddingKeysForBatch(batch);
        const missing = batch.filter(
          (row) => !existing.has(toolKey(row.service_id, row.id)),
        );
        if (missing.length === 0) continue;

        const settled = await Promise.allSettled(
          missing.map(async (row) => ({
            serviceId: row.service_id,
            toolId: row.id,
            vector: await this.embedder.embed(
              embeddingText(
                row.service_id,
                row.id,
                row.name,
                row.description,
                row.summary,
              ),
            ),
          })),
        );

        const db = this.searchDb;
        const run = db.transaction(() => {
          for (const entry of settled) {
            if (entry.status === "rejected") {
              logger.warn(
                { event: "reconcile-embed-failed", err: entry.reason },
                "Reconciliation: failed to embed tool; skipping",
              );
              result.skipped += 1;
              continue;
            }
            this.insertEmbeddingRow(
              db,
              entry.value.serviceId,
              entry.value.toolId,
              entry.value.vector,
            );
            result.embedded += 1;
          }
        });
        run();
      }
    }

    await this.deleteOrphanEmbeddings(result);
    return result;
  }

  private async queryFts(
    match: string,
    cap: number,
    serviceId?: string,
  ): Promise<string[]> {
    if (!match) return [];
    const args: Array<string | number> = [match];
    let sqlText = `SELECT service_id, tool_id FROM ${TOOLS_FTS_TABLE}
            WHERE ${TOOLS_FTS_TABLE} MATCH ?`;
    if (serviceId !== undefined) {
      sqlText += " AND service_id = ?";
      args.push(serviceId);
    }
    sqlText += `
            ORDER BY bm25(${TOOLS_FTS_TABLE}), service_id, tool_id
            LIMIT ?`;
    args.push(cap);
    const rows = await this.appDb.$client.execute({ sql: sqlText, args });
    return rows.rows.map((row) =>
      toolKey(String(row.service_id), String(row.tool_id)),
    );
  }

  private async queryVector(
    query: string,
    cap: number,
    serviceId?: string,
  ): Promise<string[]> {
    if (!this.vectorAvailable || !this.searchDb) return [];
    try {
      const vector = await this.embedder.embed(query);
      const args: Array<string | number> = [jsonVector(vector)];
      let sqlText = `SELECT service_id, tool_id, distance FROM ${TOOL_EMBEDDINGS_TABLE}
           WHERE embedding MATCH ?`;
      if (serviceId !== undefined) {
        sqlText += " AND service_id = ?";
        args.push(serviceId);
      }
      sqlText += `
           ORDER BY distance
           LIMIT ?`;
      args.push(cap);
      const rows = this.searchDb.prepare(sqlText).all(...args) as Array<{
        service_id: string;
        tool_id: string;
        distance: number;
      }>;
      rows.sort(
        (a, b) =>
          a.distance - b.distance ||
          a.service_id.localeCompare(b.service_id) ||
          a.tool_id.localeCompare(b.tool_id),
      );
      return rows.map((row) => toolKey(row.service_id, row.tool_id));
    } catch (err) {
      // Model is up but this single request failed to embed: degrade to
      // FTS5-only for this request, not for the process lifetime.
      logger.warn(
        { event: "query-embed-failed", err },
        "Query embedding failed; degrading to FTS5-only for this request",
      );
      return [];
    }
  }

  private async resolveTools(
    keys: string[],
    options: SearchOptions,
  ): Promise<Map<string, ToolSearchRow>> {
    const resolved = new Map<string, ToolSearchRow>();
    for (let i = 0; i < keys.length; i += IN_CHUNK_SIZE) {
      const chunk = keys.slice(i, i + IN_CHUNK_SIZE);
      const placeholders = chunk.map(() => "(?, ?)").join(", ");
      let sqlText = `SELECT service_id, id, name, summary, description, enabled
                     FROM tools
                     WHERE (service_id, id) IN (VALUES ${placeholders})`;
      const args: Array<string | number> = chunk.flatMap((key) =>
        key.split("\u0000"),
      );
      if (options.serviceId !== undefined) {
        sqlText += " AND service_id = ?";
        args.push(options.serviceId);
      }
      if (options.enabled !== undefined) {
        sqlText += " AND enabled = ?";
        args.push(options.enabled ? 1 : 0);
      }
      const rows = await this.appDb.$client.execute({ sql: sqlText, args });
      for (const row of rows.rows) {
        resolved.set(toolKey(String(row.service_id), String(row.id)), {
          service_id: String(row.service_id),
          id: String(row.id),
          name: String(row.name),
          summary: String(row.summary),
          description: String(row.description),
          enabled: Number(row.enabled),
        });
      }
    }
    return resolved;
  }

  private async embeddingKeysForBatch(
    rows: Array<{ service_id: string; id: string }>,
  ): Promise<Set<string>> {
    const keys = new Set<string>();
    if (!this.searchDb) return keys;
    for (let i = 0; i < rows.length; i += IN_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + IN_CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(", ");
      const matchRows = this.searchDb
        .prepare(
          `SELECT service_id, tool_id FROM ${TOOL_EMBEDDINGS_TABLE}
           WHERE id IN (${placeholders})`,
        )
        .all(...chunk.map((row) => embeddingKey(row.service_id, row.id)));
      for (const row of matchRows) {
        const ref = row as EmbeddingRef;
        keys.add(toolKey(String(ref.service_id), String(ref.tool_id)));
      }
    }
    return keys;
  }

  private async deleteOrphanEmbeddings(result: ReconcileResult): Promise<void> {
    if (!this.searchDb) return;
    const deleteOrphan = this.searchDb.prepare(
      `DELETE FROM ${TOOL_EMBEDDINGS_TABLE} WHERE id = ?`,
    );
    let lastId = -1n;
    while (true) {
      const refs = this.searchDb
        .prepare(
          `SELECT id, service_id, tool_id FROM ${TOOL_EMBEDDINGS_TABLE}
           WHERE id > ?
           ORDER BY id
           LIMIT ?`,
        )
        .all(lastId, RECONCILE_BATCH_SIZE) as Array<
        EmbeddingRef & { id: bigint | number | string }
      >;
      if (refs.length === 0) break;
      lastId = BigInt(String(refs[refs.length - 1].id));
      const chunk = refs;
      const placeholders = chunk.map(() => "(?, ?)").join(", ");
      const rows = await this.appDb.$client.execute({
        sql: `SELECT service_id, id FROM tools
              WHERE (service_id, id) IN (VALUES ${placeholders})`,
        args: chunk.flatMap((ref) => [ref.service_id, ref.tool_id]),
      });
      const alive = new Set(
        rows.rows.map((row) => toolKey(String(row.service_id), String(row.id))),
      );
      const orphans = chunk.filter(
        (ref) => !alive.has(toolKey(ref.service_id, ref.tool_id)),
      );
      if (orphans.length === 0) continue;
      const db = this.searchDb;
      const run = db.transaction(() => {
        for (const orphan of orphans) {
          deleteOrphan.run(embeddingKey(orphan.service_id, orphan.tool_id));
        }
      });
      run();
      result.deleted += orphans.length;
    }
  }

  private insertEmbeddingRow(
    db: Database.Database,
    serviceId: string,
    toolId: string,
    vector: Float32Array,
  ): void {
    const id = embeddingKey(serviceId, toolId);
    db.prepare(`DELETE FROM ${TOOL_EMBEDDINGS_TABLE} WHERE id = ?`).run(id);
    db.prepare(
      `INSERT INTO ${TOOL_EMBEDDINGS_TABLE} (id, service_id, tool_id, embedding)
       VALUES (?, ?, ?, ?)`,
    ).run(id, serviceId, toolId, jsonVector(vector));
  }
}
