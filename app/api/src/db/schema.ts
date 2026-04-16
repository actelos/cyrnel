import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import type { DefinitionType } from "@/models/definition.model";
import type { ManifestMetadata, ToolDefinition } from "@/models/manifest.model";

export const definitions = sqliteTable("definitions", {
  id: text("id").primaryKey(),
  type: text("type").$type<DefinitionType>().notNull(),
  description: text("description").notNull().default(""),
  content: blob("content", { mode: "buffer" }).notNull(),
  hash: text("hash").notNull(),
});

export const manifests = sqliteTable(
  "manifests",
  {
    id: text("id").primaryKey(),
    definitionId: text("definition_id")
      .unique()
      .references(() => definitions.id, {
        onDelete: "cascade",
      }),
    description: text("description").notNull().default(""),
    hash: text("hash").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    metadata: text("metadata", { mode: "json" })
      .$type<ManifestMetadata>()
      .notNull(),
  },
  (table) => [index("manifests_definition_id_idx").on(table.definitionId)],
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

export type ManifestRecord = typeof manifests.$inferSelect;
export type NewManifestRecord = typeof manifests.$inferInsert;
export type DefinitionRecord = typeof definitions.$inferSelect;
export type NewDefinitionRecord = typeof definitions.$inferInsert;
export type ToolRecord = typeof tools.$inferSelect;
export type NewToolRecord = typeof tools.$inferInsert;
