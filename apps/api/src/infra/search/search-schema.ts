// Raw DDL for the hybrid search index (FTS5 + sqlite-vec). Virtual tables
// cannot be modeled by drizzle-kit, so this module owns them. All statements
// are idempotent and run at startup (see SearchEngine.init), keeping the
// `tools` table the single source of truth:
//   - FTS5 content is mirrored by triggers, so it can never drift from tools.
//   - Embeddings are maintained by app-level hooks plus reconciliation
//     (vector math cannot run inside SQLite triggers).

export const SEARCH_DIMENSIONS = 384;

export const TOOLS_FTS_TABLE = "tools_fts";
export const TOOL_EMBEDDINGS_TABLE = "tool_embeddings";
export const TOOL_EMBEDDINGS_METADATA_TABLE = "tool_embeddings_metadata";

// Mirror of `tools` rows that predate the triggers. Triggers only fire on
// writes after they exist, so tools present before init() would otherwise
// never reach the FTS mirror; startup clears the mirror and repopulates it.
export const FTS5_BACKFILL_CLEAR = `DELETE FROM ${TOOLS_FTS_TABLE}`;

export const FTS5_BACKFILL = `INSERT INTO ${TOOLS_FTS_TABLE} (rowid, service_id, tool_id, name, summary, description)
  SELECT rowid, service_id, id, name, summary, description FROM tools`;

export const TOOL_EMBEDDINGS_METADATA_STATEMENT = `CREATE TABLE IF NOT EXISTS ${TOOL_EMBEDDINGS_METADATA_TABLE} (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  embedding_model TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL
)`;

// FTS5 mirror of `tools`. `service_id`/`tool_id` are stored UNINDEXED (for
// join-back) while `name`, `summary` and `description` are indexed.
//
// The triggers key FTS rows on `tools.rowid`, which is stable for the
// lifetime of a row under standard SQLite semantics. This assumption breaks
// if `tools` ever gains an INTEGER PRIMARY KEY that is not a rowid alias, or
// if the table is recreated by VACUUM-like migration tooling; in that case
// FTS content would silently desync from `tools`.
export const FTS5_STATEMENTS: readonly string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS ${TOOLS_FTS_TABLE} USING fts5(
    service_id UNINDEXED,
    tool_id UNINDEXED,
    name,
    summary,
    description
  )`,
  `CREATE TRIGGER IF NOT EXISTS tools_fts_ai AFTER INSERT ON tools BEGIN
    INSERT INTO ${TOOLS_FTS_TABLE} (rowid, service_id, tool_id, name, summary, description)
    VALUES (new.rowid, new.service_id, new.id, new.name, new.summary, new.description);
  END`,
  `CREATE TRIGGER IF NOT EXISTS tools_fts_ad AFTER DELETE ON tools BEGIN
    DELETE FROM ${TOOLS_FTS_TABLE} WHERE rowid = old.rowid;
  END`,
  `CREATE TRIGGER IF NOT EXISTS tools_fts_au AFTER UPDATE ON tools BEGIN
    DELETE FROM ${TOOLS_FTS_TABLE} WHERE rowid = old.rowid;
    INSERT INTO ${TOOLS_FTS_TABLE} (rowid, service_id, tool_id, name, summary, description)
    VALUES (new.rowid, new.service_id, new.id, new.name, new.summary, new.description);
  END`,
];

export function embeddingsStatement(dimensions: number): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS ${TOOL_EMBEDDINGS_TABLE} USING vec0(
    embedding float[${dimensions}] distance_metric=cosine,
    service_id text,
    tool_id text,
    id integer primary key
  )`;
}
