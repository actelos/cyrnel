import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import type {
  ManifestMetadata,
  ServiceType,
  ToolDefinition,
} from "@/models/manifest.model";

export const manifests = sqliteTable(
  "manifests",
  {
    id: text("id").primaryKey(),
    type: text("type").$type<ServiceType>().notNull(),
    source: text("source").notNull().default(""),
    description: text("description").notNull().default(""),
    hash: text("hash").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    metadata: text("metadata", { mode: "json" })
      .$type<ManifestMetadata>()
      .notNull(),
  },
  (table) => [index("manifests_type_idx").on(table.type)],
);

export const tools = sqliteTable(
  "tools",
  {
    serviceName: text("service_id")
      .notNull()
      .references(() => manifests.id, {
        onDelete: "cascade",
      }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    inputSchema: text("input_schema", { mode: "json" })
      .$type<ToolDefinition["inputSchema"]>()
      .notNull(),
    outputSchema: text("output_schema", { mode: "json" })
      .$type<ToolDefinition["outputSchema"]>()
      .notNull(),
    metadata: text("metadata", { mode: "json" })
      .$type<ToolDefinition["metadata"]>()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.serviceName, table.name] }),
    index("tools_name_idx").on(table.name),
  ],
);

export const logs = sqliteTable(
  "logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    timestampMs: integer("timestamp_ms", { mode: "number" }).notNull(),
    severity: text("severity").notNull(),
    level: integer("level").notNull(),
    message: text("message").notNull(),
    requestMethod: text("request_method"),
    requestPath: text("request_path"),
    statusCode: integer("status_code"),
    raw: text("raw", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [
    index("logs_timestamp_idx").on(table.timestampMs),
    index("logs_severity_idx").on(table.severity),
    index("logs_message_idx").on(table.message),
  ],
);

export type ManifestRecord = typeof manifests.$inferSelect;
export type NewManifestRecord = typeof manifests.$inferInsert;
export type ToolRecord = typeof tools.$inferSelect;
export type NewToolRecord = typeof tools.$inferInsert;
export type LogRecord = typeof logs.$inferSelect;
export type NewLogRecord = typeof logs.$inferInsert;
