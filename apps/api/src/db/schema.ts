import type { AuthScheme, JSONSchema, SecurityRequirements } from "@cyrnel/sdk";
import { sql } from "drizzle-orm";
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import type { ModuleType } from "@/models/modules.model";
import type { EncryptedSecretsPayload } from "@/models/secrets.model";

export const modules = sqliteTable(
  "modules",
  {
    id: text("id").primaryKey(),
    createdAt: text("created_at").notNull().default("1970-01-01T00:00:00.000Z"),
    name: text("name").notNull(),
    type: text("type").$type<ModuleType>().notNull(),
    summary: text("summary").notNull().default(""),
    description: text("description").notNull().default(""),
    hash: text("hash").notNull().default(""),
    version: text("version").notNull().default("0.0.0"),
    source: text("source").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    missing: integer("missing", { mode: "boolean" }).notNull().default(false),
    autoUpdate: integer("auto_update", { mode: "boolean" })
      .notNull()
      .default(false),
    autoUpdateConstraint: text("auto_update_constraint"),
    iconData: blob("icon_data", { mode: "buffer" }),
    iconMime: text("icon_mime"),
    iconHash: text("icon_hash"),
    schemes: text("auth_schemes", { mode: "json" }).$type<
      Record<string, AuthScheme>
    >(),
    security: text("default_security", {
      mode: "json",
    }).$type<SecurityRequirements>(),
  },
  (table) => [
    index("modules_type_idx").on(table.type),
    index("modules_created_at_idx").on(table.createdAt, table.id),
  ],
);

export const services = sqliteTable(
  "services",
  {
    id: text("id").primaryKey(),
    createdAt: text("created_at").notNull().default("1970-01-01T00:00:00.000Z"),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    description: text("description").notNull().default(""),
    hash: text("hash").notNull(),
    version: text("version").notNull().default("0.0.0"),
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
    schemes: text("auth_schemes", { mode: "json" }).$type<
      Record<string, AuthScheme>
    >(),
    security: text("default_security", {
      mode: "json",
    }).$type<SecurityRequirements>(),
    definitionContent: text("definition_content").notNull().default(""),
    stale: integer("stale", { mode: "boolean" }).notNull().default(false),
    autoUpdate: integer("auto_update", { mode: "boolean" })
      .notNull()
      .default(false),
    autoUpdateConstraint: text("auto_update_constraint"),
    iconData: blob("icon_data", { mode: "buffer" }),
    iconMime: text("icon_mime"),
    iconHash: text("icon_hash"),
  },
  (table) => [index("services_created_at_idx").on(table.createdAt, table.id)],
);

export const tools = sqliteTable(
  "tools",
  {
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
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
    security: text("security", { mode: "json" }).$type<SecurityRequirements>(),
  },
  (table) => [
    primaryKey({ columns: [table.serviceId, table.id] }),
    index("tools_name_idx").on(table.name),
  ],
);

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

export const registries = sqliteTable("registries", {
  id: text("id").primaryKey(),
  baseUrl: text("base_url").notNull().unique(),
  lastSyncedAt: text("last_synced_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const registryAuth = sqliteTable("registry_auth", {
  registryId: text("registry_id")
    .primaryKey()
    .references(() => registries.id, { onDelete: "cascade" }),
  authType: text("auth_type").$type<"apiKey" | "oauth2">().notNull(),
  config: text("config", { mode: "json" })
    .$type<EncryptedSecretsPayload>()
    .notNull(),
  token: text("token", { mode: "json" }).$type<EncryptedSecretsPayload>(),
  tokenEndpoint: text("token_endpoint"),
  headerName: text("header_name"),
  tokenExpiresAt: integer("token_expires_at"),
  updatedAt: integer("updated_at").notNull(),
});

export const processes = sqliteTable("processes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ref: text("ref").unique(),
  code: text("code").notNull(),
  timeoutMs: integer("timeout_ms"),
  envConfig: text("env_config", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: text("created_at").notNull(),
  state: text("state", {
    enum: [
      "idle",
      "queued",
      "running",
      "suspended",
      "terminating",
      "terminated",
    ],
  })
    .notNull()
    .default("idle"),
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

export const toolPolicies = sqliteTable(
  "tool_policies",
  {
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    toolId: text("tool_id").notNull(),
    decision: text("decision", { enum: ["allow", "block", "ask"] }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: integer("updated_at"),
  },
  (t) => [primaryKey({ columns: [t.serviceId, t.toolId] })],
);

export const approvalRequests = sqliteTable(
  "approval_requests",
  {
    id: text("id").primaryKey(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    toolId: text("tool_id").notNull(),
    processId: integer("process_id"),
    parameters: text("parameters").notNull(),
    state: text("state", {
      enum: ["pending", "approved", "denied", "expired"],
    }).notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    decidedAt: integer("decided_at"),
  },
  (t) => [
    index("approval_requests_state_idx").on(t.state),
    index("approval_requests_created_idx").on(t.createdAt, t.id),
    index("approval_requests_expiry_idx").on(t.state, t.expiresAt),
    index("approval_requests_decided_idx").on(t.state, t.decidedAt),
    index("approval_requests_process_id_idx").on(t.processId),
  ],
);

export const serviceCredentials = sqliteTable(
  "service_credentials",
  {
    id: text("id").primaryKey(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    schemeName: text("scheme_name").notNull(),
    schemeType: text("scheme_type")
      .notNull()
      .$type<"apiKey" | "basic" | "bearer" | "oauth2">(),
    status: text("status")
      .notNull()
      .default("active")
      .$type<"active" | "expired" | "revoked" | "error">(),
    oauthClientId: text("oauth_client_id").references(() => oauthClients.id, {
      onDelete: "restrict",
    }),
    requestedScopes: text("requested_scopes", { mode: "json" })
      .$type<string[]>()
      .default(sql`'[]'`),
    grantedScopes: text("granted_scopes", { mode: "json" }).$type<string[]>(),
    grantedSource: text("granted_source").$type<"provider" | "inferred">(),
    createdAt: text("created_at").notNull().default("1970-01-01T00:00:00.000Z"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("service_credentials_owner_scheme_unique").on(
      table.serviceId,
      table.schemeName,
    ),
    index("service_credentials_client_idx").on(table.oauthClientId),
  ],
);

export const serviceCredentialAuth = sqliteTable("service_credential_auth", {
  credentialId: text("credential_id")
    .primaryKey()
    .references(() => serviceCredentials.id, { onDelete: "cascade" }),
  schemeType: text("scheme_type")
    .notNull()
    .$type<"apiKey" | "basic" | "bearer" | "oauth2">(),
  payload: text("payload", { mode: "json" })
    .$type<EncryptedSecretsPayload>()
    .notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const moduleCredentials = sqliteTable(
  "module_credentials",
  {
    id: text("id").primaryKey(),
    moduleId: text("module_id")
      .notNull()
      .references(() => modules.id, { onDelete: "cascade" }),
    schemeName: text("scheme_name").notNull(),
    schemeType: text("scheme_type")
      .notNull()
      .$type<"apiKey" | "basic" | "bearer" | "oauth2">(),
    status: text("status")
      .notNull()
      .default("active")
      .$type<"active" | "expired" | "revoked" | "error">(),
    oauthClientId: text("oauth_client_id").references(() => oauthClients.id, {
      onDelete: "restrict",
    }),
    requestedScopes: text("requested_scopes", { mode: "json" })
      .$type<string[]>()
      .default(sql`'[]'`),
    grantedScopes: text("granted_scopes", { mode: "json" }).$type<string[]>(),
    grantedSource: text("granted_source").$type<"provider" | "inferred">(),
    createdAt: text("created_at").notNull().default("1970-01-01T00:00:00.000Z"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("module_credentials_owner_scheme_unique").on(
      table.moduleId,
      table.schemeName,
    ),
    index("module_credentials_client_idx").on(table.oauthClientId),
  ],
);

export const moduleCredentialAuth = sqliteTable("module_credential_auth", {
  credentialId: text("credential_id")
    .primaryKey()
    .references(() => moduleCredentials.id, { onDelete: "cascade" }),
  schemeType: text("scheme_type")
    .notNull()
    .$type<"apiKey" | "basic" | "bearer" | "oauth2">(),
  payload: text("payload", { mode: "json" })
    .$type<EncryptedSecretsPayload>()
    .notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const registryCredentials = sqliteTable(
  "registry_credentials",
  {
    id: text("id").primaryKey(),
    registryId: text("registry_id")
      .notNull()
      .references(() => registries.id, { onDelete: "cascade" }),
    schemeName: text("scheme_name").notNull(),
    schemeType: text("scheme_type")
      .notNull()
      .$type<"apiKey" | "basic" | "bearer" | "oauth2">(),
    status: text("status")
      .notNull()
      .default("active")
      .$type<"active" | "expired" | "revoked" | "error">(),
    oauthClientId: text("oauth_client_id").references(() => oauthClients.id, {
      onDelete: "restrict",
    }),
    requestedScopes: text("requested_scopes", { mode: "json" })
      .$type<string[]>()
      .default(sql`'[]'`),
    grantedScopes: text("granted_scopes", { mode: "json" }).$type<string[]>(),
    grantedSource: text("granted_source").$type<"provider" | "inferred">(),
    createdAt: text("created_at").notNull().default("1970-01-01T00:00:00.000Z"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("registry_credentials_owner_scheme_unique").on(
      table.registryId,
      table.schemeName,
    ),
    index("registry_credentials_client_idx").on(table.oauthClientId),
  ],
);

export const registryCredentialAuth = sqliteTable("registry_credential_auth", {
  credentialId: text("credential_id")
    .primaryKey()
    .references(() => registryCredentials.id, { onDelete: "cascade" }),
  schemeType: text("scheme_type")
    .notNull()
    .$type<"apiKey" | "basic" | "bearer" | "oauth2">(),
  payload: text("payload", { mode: "json" })
    .$type<EncryptedSecretsPayload>()
    .notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const oauthClients = sqliteTable("oauth_clients", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  clientId: text("client_id").notNull(),
  clientSecret: text("client_secret", { mode: "json" })
    .$type<EncryptedSecretsPayload>()
    .notNull(),
  tokenUrl: text("token_url").notNull(),
  authorizationUrl: text("authorization_url"),
  clientAuthMethod: text("client_auth_method")
    .notNull()
    .default("client_secret_basic"),
  redirectUris: text("redirect_uris", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  availableScopes: text("available_scopes", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const oauthPendings = sqliteTable(
  "oauth_pendings",
  {
    state: text("state").primaryKey(),
    serviceCredentialId: text("service_credential_id").references(
      () => serviceCredentials.id,
      { onDelete: "cascade" },
    ),
    moduleCredentialId: text("module_credential_id").references(
      () => moduleCredentials.id,
      { onDelete: "cascade" },
    ),
    registryCredentialId: text("registry_credential_id").references(
      () => registryCredentials.id,
      { onDelete: "cascade" },
    ),
    codeVerifier: text("code_verifier").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    requestedScopes: text("requested_scopes", { mode: "json" }).$type<
      string[]
    >(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("oauth_pendings_expiry_idx").on(table.expiresAt),
    check(
      "oauth_pendings_single_owner",
      sql`(( ${table.serviceCredentialId} IS NOT NULL) + ( ${table.moduleCredentialId} IS NOT NULL) + ( ${table.registryCredentialId} IS NOT NULL)) = 1`,
    ),
  ],
);

export type ModuleRecord = typeof modules.$inferSelect;
export type NewModuleRecord = typeof modules.$inferInsert;

export type ServiceRecord = typeof services.$inferSelect;
export type NewServiceRecord = typeof services.$inferInsert;

export type ToolRecord = typeof tools.$inferSelect;
export type NewToolRecord = typeof tools.$inferInsert;

export type ServiceConfigurationRecord =
  typeof serviceConfigurations.$inferSelect;
export type NewServiceConfigurationRecord =
  typeof serviceConfigurations.$inferInsert;

export type ServiceSecretsRecord = typeof serviceSecrets.$inferSelect;
export type NewServiceSecretsRecord = typeof serviceSecrets.$inferInsert;

export type ModuleConfigurationRecord =
  typeof moduleConfigurations.$inferSelect;
export type NewModuleConfigurationRecord =
  typeof moduleConfigurations.$inferInsert;

export type ModuleSecretsRecord = typeof moduleSecrets.$inferSelect;
export type NewModuleSecretsRecord = typeof moduleSecrets.$inferInsert;

export type RegistryRecord = typeof registries.$inferSelect;
export type NewRegistryRecord = typeof registries.$inferInsert;
export type RegistryAuthRecord = typeof registryAuth.$inferSelect;
export type NewRegistryAuthRecord = typeof registryAuth.$inferInsert;

export type ProcessRow = typeof processes.$inferSelect;
export type NewProcessRow = typeof processes.$inferInsert;
export type ProcessDataRow = typeof processData.$inferSelect;
export type NewProcessDataRow = typeof processData.$inferInsert;

export type ToolPolicyRecord = typeof toolPolicies.$inferSelect;
export type NewToolPolicyRecord = typeof toolPolicies.$inferInsert;
export type ApprovalRequestRecord = typeof approvalRequests.$inferSelect;
export type NewApprovalRequestRecord = typeof approvalRequests.$inferInsert;

export type ServiceCredentialRecord = typeof serviceCredentials.$inferSelect;
export type NewServiceCredentialRecord = typeof serviceCredentials.$inferInsert;

export type ServiceCredentialAuthRecord =
  typeof serviceCredentialAuth.$inferSelect;
export type NewServiceCredentialAuthRecord =
  typeof serviceCredentialAuth.$inferInsert;

export type ModuleCredentialRecord = typeof moduleCredentials.$inferSelect;
export type NewModuleCredentialRecord = typeof moduleCredentials.$inferInsert;

export type ModuleCredentialAuthRecord =
  typeof moduleCredentialAuth.$inferSelect;
export type NewModuleCredentialAuthRecord =
  typeof moduleCredentialAuth.$inferInsert;

export type RegistryCredentialRecord = typeof registryCredentials.$inferSelect;
export type NewRegistryCredentialRecord =
  typeof registryCredentials.$inferInsert;

export type RegistryCredentialAuthRecord =
  typeof registryCredentialAuth.$inferSelect;
export type NewRegistryCredentialAuthRecord =
  typeof registryCredentialAuth.$inferInsert;

export type OAuthClientRecord = typeof oauthClients.$inferSelect;
export type NewOAuthClientRecord = typeof oauthClients.$inferInsert;

export type OAuthPendingRecord = typeof oauthPendings.$inferSelect;
export type NewOAuthPendingRecord = typeof oauthPendings.$inferInsert;
