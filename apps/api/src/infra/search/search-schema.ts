export const TOOLS_FTS_TABLE = "tools_fts";
export const TOOL_EMBEDDINGS_TABLE = "tool_embeddings";
export const TOOL_EMBEDDINGS_METADATA_TABLE = "tool_embeddings_metadata";

export const FTS5_BACKFILL_CLEAR = `DELETE FROM ${TOOLS_FTS_TABLE}`;

export const FTS5_BACKFILL = `INSERT INTO ${TOOLS_FTS_TABLE} (rowid, service_id, tool_id, name, summary, description)
  SELECT rowid, service_id, id, name, summary, description FROM tools`;

export const TOOL_EMBEDDINGS_METADATA_STATEMENT = `CREATE TABLE IF NOT EXISTS ${TOOL_EMBEDDINGS_METADATA_TABLE} (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  embedding_model TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL
)`;

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
