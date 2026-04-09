import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { ManifestMetadata, ToolDefinition } from "@/models/manifest.model";

export const manifests = sqliteTable("manifests", {
  id: text("id").primaryKey(),
  metadata: text("metadata", { mode: "json" })
    .$type<ManifestMetadata>()
    .notNull(),
});

export const tools = sqliteTable(
  "tools",
  {
    serviceName: text("service_id")
      .notNull()
      .references(() => manifests.id, {
        onDelete: "cascade",
      }),
    name: text("name").notNull(),
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
export type ToolRecord = typeof tools.$inferSelect;
export type NewToolRecord = typeof tools.$inferInsert;
