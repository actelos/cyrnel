import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import type {
  JSONSchema,
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
    configSchema: text("config_schema", { mode: "json" })
      .$type<JSONSchema>()
      .notNull(),
  },
  (table) => [index("manifests_type_idx").on(table.type)],
);

export const services = sqliteTable("services", {
  id: text("id")
    .primaryKey()
    .references(() => manifests.id, { onDelete: "cascade" }),
  configSchema: text("config_schema", { mode: "json" })
    .$type<JSONSchema>()
    .notNull(),
});

export const serviceConfigs = sqliteTable("service_configs", {
  serviceName: text("service_name")
    .primaryKey()
    .references(() => services.id, { onDelete: "cascade" }),
  config: text("config", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  updatedAt: integer("updated_at").notNull(),
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
export type ServiceRecord = typeof services.$inferSelect;
export type NewServiceRecord = typeof services.$inferInsert;
export type ServiceConfigRecord = typeof serviceConfigs.$inferSelect;
export type NewServiceConfigRecord = typeof serviceConfigs.$inferInsert;
export type ToolRecord = typeof tools.$inferSelect;
export type NewToolRecord = typeof tools.$inferInsert;
