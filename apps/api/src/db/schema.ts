import type { JSONSchema } from "@cyrnel/sdk";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import type { ModuleType } from "@/models/modules.model";
import type { EncryptedSecretsPayload } from "@/models/secrets.model";

export const services = sqliteTable("services", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  hash: text("hash").notNull(),
  source: text("source").notNull().default(""),
  adapter: text("adapter")
    .notNull()
    .references(() => modules.id, { onDelete: "cascade" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  configSchema: text("config_schema", { mode: "json" })
    .$type<JSONSchema>()
    .notNull(),
  secretsSchema: text("secrets_schema", { mode: "json" })
    .$type<JSONSchema>()
    .notNull(),
  adapterDomain: text("adapter_domain", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull(),
  definitionContent: text("definition_content").notNull().default(""),
  stale: integer("stale", { mode: "boolean" }).notNull().default(false),
});

export const serviceConfigurations = sqliteTable("service_configurations", {
  serviceId: text("service_id")
    .primaryKey()
    .references(() => services.id, { onDelete: "cascade" }),
  payload: text("payload", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  updatedAt: integer("updated_at").notNull(),
});

export const serviceSecrets = sqliteTable("service_secrets", {
  serviceId: text("service_id")
    .primaryKey()
    .references(() => services.id, { onDelete: "cascade" }),
  payload: text("payload", { mode: "json" })
    .$type<EncryptedSecretsPayload>()
    .notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const tools = sqliteTable(
  "tools",
  {
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    inputSchema: text("input_schema", { mode: "json" })
      .$type<JSONSchema>()
      .notNull(),
    outputSchema: text("output_schema", { mode: "json" })
      .$type<JSONSchema>()
      .notNull(),
    adapterDomain: text("adapter_domain", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.serviceId, table.id] }),
    index("tools_name_idx").on(table.name),
  ],
);

export const modules = sqliteTable(
  "modules",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").$type<ModuleType>().notNull(),
    description: text("description").notNull().default(""),
    hash: text("hash").notNull().default(""),
    source: text("source").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    missing: integer("missing", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [index("modules_type_idx").on(table.type)],
);

export const moduleConfigurations = sqliteTable("module_configurations", {
  moduleId: text("module_id")
    .primaryKey()
    .references(() => modules.id, { onDelete: "cascade" }),
  payload: text("payload", { mode: "json" })
    .$type<Record<string, unknown> | null>()
    .notNull()
    .default({}),
  updatedAt: integer("updated_at").notNull(),
});

export const moduleSecrets = sqliteTable("module_secrets", {
  moduleId: text("module_id")
    .primaryKey()
    .references(() => modules.id, { onDelete: "cascade" }),
  payload: text("payload", { mode: "json" })
    .$type<EncryptedSecretsPayload>()
    .notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type ServiceRecord = typeof services.$inferSelect;
export type NewServiceRecord = typeof services.$inferInsert;

export type ServiceConfigurationRecord =
  typeof serviceConfigurations.$inferSelect;
export type NewServiceConfigurationRecord =
  typeof serviceConfigurations.$inferInsert;

export type ServiceSecretsRecord = typeof serviceSecrets.$inferSelect;
export type NewServiceSecretsRecord = typeof serviceSecrets.$inferInsert;

export type ToolRecord = typeof tools.$inferSelect;
export type NewToolRecord = typeof tools.$inferInsert;

export type ModuleRecord = typeof modules.$inferSelect;
export type NewModuleRecord = typeof modules.$inferInsert;

export type ModuleConfigurationRecord =
  typeof moduleConfigurations.$inferSelect;
export type NewModuleConfigurationRecord =
  typeof moduleConfigurations.$inferInsert;

export type ModuleSecretsRecord = typeof moduleSecrets.$inferSelect;
export type NewModuleSecretsRecord = typeof moduleSecrets.$inferInsert;

export const processes = sqliteTable("processes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ref: text("ref").unique(),
  description: text("description").notNull().default(""),
  code: text("code").notNull(),
  options: text("options", { mode: "json" })
    .$type<{ timeoutMs?: number | null }>()
    .notNull()
    .default({}),
  createdAt: text("created_at").notNull(),
});

export const processData = sqliteTable("process_data", {
  processId: integer("process_id")
    .primaryKey()
    .references(() => processes.id, { onDelete: "cascade" }),
  exitState: text("exit_state"),
  error: text("error"),
  output: text("output", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  stdout: text("stdout"),
  stderr: text("stderr"),
  completedAt: text("completed_at").notNull(),
});

export type ProcessRow = typeof processes.$inferSelect;
export type NewProcessRow = typeof processes.$inferInsert;
export type ProcessDataRow = typeof processData.$inferSelect;
export type NewProcessDataRow = typeof processData.$inferInsert;
