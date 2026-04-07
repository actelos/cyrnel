import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { ManifestMetadata, ServiceManifest, ToolDefinition } from "@/models/manifest.model";

export const manifests = sqliteTable("manifests", {
  id: text("id").primaryKey(),
  metadata: text("metadata", { mode: "json" }).$type<ManifestMetadata>().notNull(),
  tools: text("tools", { mode: "json" }).$type<ToolDefinition[]>().notNull(),
});

export type ManifestRecord = typeof manifests.$inferSelect;
export type NewManifestRecord = typeof manifests.$inferInsert;
export type ManifestShape = ServiceManifest;
