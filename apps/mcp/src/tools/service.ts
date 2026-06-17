import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { z } from "zod";

import { JsonPatch, ServiceId } from "@/schemas.js";
import { api, searchParams } from "@/utils/fetch.js";

// biome-ignore lint/suspicious/noExplicitAny: tool params vary per entry
export const serviceTools: Tool<FastMCPSessionAuth, z.ZodType<any>>[] = [
  {
    name: "list_services",
    description: `
    List installed services with optional query/enabled/stale filters.

    Results include an \`effectivelyEnabled\` field that reflects whether the
    service is actually usable considering its own state, its parent module's
    state, and whether the module is missing from disk. This tool does NOT
    expose tools — use \`list_tools\` for that.

    When to use:
      - Use when you want to shortlist services by name/description.
    When NOT to use:
      - If you already know the exact service id, call \`get_service\` instead.
    `,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      query: z
        .string()
        .optional()
        .describe('Optional search string. Example: "github".'),
      enabled: z.boolean().optional().describe("Optional enabled filter."),
      stale: z
        .boolean()
        .optional()
        .describe(
          "Optional stale filter. true = stale only, false = fresh only.",
        ),
    }),
    execute: async ({ query, enabled, stale }) =>
      JSON.stringify(
        await api
          .get("services", {
            searchParams: searchParams({ query, enabled, stale }),
          })
          .json(),
      ),
  },
  {
    name: "get_service",
    description: `
    Fetch a single service by exact id, returning metadata and schemas.

    When to use:
      - Use when you already know the exact service id.
    When NOT to use:
      - If you only have a substring, call \`list_services\` first.
    `,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({ service_id: ServiceId }),
    execute: async ({ service_id }) =>
      JSON.stringify(await api.get(`services/${service_id}`).json()),
  },
  {
    name: "create_service",
    description: `
    Install a service by resolving a registry source URL.

    Fetches the registry metadata API at \`source\`, resolves the download URL
    and optional defaults (adapter, service id), then generates and persists
    the service definition. The installed service starts disabled — call
    \`set_service_enabled\` once its configuration/secrets are set.

    When to use:
      - Use to install a service from a registry URL.
    When NOT to use:
      - For a direct manifest URL, use \`add_service\` instead.
      - If the service is already installed and you want to refresh it from the
        stored source, use \`update_service\`.
    `,
    annotations: { idempotentHint: false, openWorldHint: true },
    parameters: z.object({
      source: z
        .string()
        .min(1)
        .describe(
          'Registry URL that returns service metadata { downloadUrl, hash?, id?, adapter? }. Example: "https://registry.example.com/services/my-service".',
        ),
      adapter: z
        .string()
        .optional()
        .describe(
          'Override the registry\'s default adapter module id. Example: "openapi".',
        ),
      service_id: z
        .string()
        .optional()
        .describe(
          'Override the registry\'s default service id. Must be a valid TypeScript identifier. Example: "my-service".',
        ),
    }),
    execute: async ({ source, adapter, service_id }) => {
      const body: Record<string, unknown> = { source };
      if (adapter !== undefined) body.adapter = adapter;
      if (service_id !== undefined) body.id = service_id;
      return JSON.stringify(
        await api.post("services/install", { json: body }).json(),
      );
    },
  },
  {
    name: "add_service",
    description: `
    Install a service directly from a manifest URL using the named adapter.

    The API downloads the manifest from \`url\`, hands it to the named
    \`adapter\` module, and persists the result. No registry resolution — the
    URL must point directly at a definition file. The installed service starts
    disabled — call \`set_service_enabled\` once its configuration/secrets are
    set.

    When to use:
      - Use to install a service from a direct manifest URL.
    When NOT to use:
      - To install via a registry, use \`create_service\` instead.
      - If the service is already installed and you want to replace it from a
        new URL, use \`patch_service\` instead.
    `,
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    parameters: z.object({
      service_id: z
        .string()
        .min(1)
        .describe(
          "Unique service identifier. Must be a valid TypeScript identifier.",
        ),
      url: z.string().min(1).describe("Direct manifest definition URL."),
      adapter: z
        .string()
        .min(1)
        .describe("Adapter module id used to generate the service definition."),
    }),
    execute: async ({ service_id, url, adapter }) =>
      JSON.stringify(
        await api
          .post("services", {
            json: { id: service_id, url, adapter },
          })
          .json(),
      ),
  },
  {
    name: "update_service",
    description: `
    Re-resolve the stored registry source URL and re-install if changed.

    Fetches the registry metadata, compares hashes, and re-generates the
    service definition if a new version is available. Requires a
    registry-installed service (source !== ""). Existing tool enabled flags
    are preserved by name; the service itself is set back to disabled and
    must be re-enabled.

    When to use:
      - Use to pull the latest version of a registry-installed service.
    When NOT to use:
      - For a direct-installed service (no registry source), use
        \`patch_service\` instead.
      - If you just need to toggle enablement, use \`set_service_enabled\`.
    `,
    annotations: { idempotentHint: false, openWorldHint: true },
    parameters: z.object({ service_id: ServiceId }),
    execute: async ({ service_id }) =>
      JSON.stringify(
        await api.post(`services/${service_id}/update`, { json: {} }).json(),
      ),
  },
  {
    name: "sync_service",
    description: `
    Re-generate a service's tools from its stored definition content.

    Re-runs the adapter's \`generateDefinition\` using the definition content
    that was persisted at install/update time. No network IO — the definition
    is read from the database. Clears the \`stale\` flag if the service was
    marked stale after an adapter module update.

    When to use:
      - Use to recover a service that was marked \`stale\` after an adapter
        module update failed to regenerate its tools.
    When NOT to use:
      - If the service is working fine, no need to sync.
      - To pull a new version from a registry or URL, use \`update_service\`
        or \`patch_service\` instead.
    `,
    annotations: { idempotentHint: false, openWorldHint: true },
    parameters: z.object({ service_id: ServiceId }),
    execute: async ({ service_id }) =>
      JSON.stringify(
        await api.post(`services/${service_id}/sync`, { json: {} }).json(),
      ),
  },
  {
    name: "patch_service",
    description: `
    Update a service's definition URL directly (manual update).

    Sets a new definition URL on an existing service and re-installs it.
    Existing tool enabled flags are preserved by name; the service itself is
    set back to disabled and must be re-enabled.

    When to use:
      - Use to change a direct-installed service's manifest URL.
    When NOT to use:
      - For a registry-installed service, use \`update_service\` instead.
      - If you just need to toggle enablement, use \`set_service_enabled\`.
    `,
    annotations: { idempotentHint: false, openWorldHint: true },
    parameters: z.object({
      service_id: ServiceId,
      url: z.string().min(1).describe("New definition URL."),
    }),
    execute: async ({ service_id, url }) =>
      JSON.stringify(
        await api.patch(`services/${service_id}`, { json: { url } }).json(),
      ),
  },
  {
    name: "set_service_enabled",
    description: `
    Enable or disable a service by id.

    When enabling, the API validates the stored configuration and secrets
    against the service's JSON Schemas. If either is invalid, the API responds
    with 400.

    When to use:
      - Use to toggle a service on/off.
    When NOT to use:
      - If you need to remove the service permanently, use \`delete_service\`.`,
    annotations: { idempotentHint: true, openWorldHint: true },
    parameters: z.object({
      service_id: ServiceId,
      enabled: z
        .boolean()
        .describe("Desired enabled state for the service. Example: true."),
    }),
    execute: async ({ service_id, enabled }) =>
      JSON.stringify(
        await api
          .post(`services/${service_id}/enabled`, { json: { enabled } })
          .json(),
      ),
  },
  {
    name: "delete_service",
    description: `
    Delete an installed service by id, returning \`ok=true\` on HTTP 204.

    This permanently removes the service row plus its tools, configuration, and
    secrets via cascading delete.

    When to use:
      - Use to uninstall a service you no longer need.
    When NOT to use:
      - If you only want to disable the service temporarily, use
        \`set_service_enabled\`.
    `,
    annotations: { destructiveHint: true, openWorldHint: true },
    parameters: z.object({ service_id: ServiceId }),
    execute: async ({ service_id }) => {
      await api.delete(`services/${service_id}`);
      return JSON.stringify({ ok: true });
    },
  },
  {
    name: "get_service_config_schema",
    description: `
    Fetch a service's configuration JSON Schema by service id.

    When to use:
      - Use to learn which configuration keys/values a service accepts.
    When NOT to use:
      - If you need the current configured values, call \`get_service_config\`.
    `,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({ service_id: ServiceId }),
    execute: async ({ service_id }) =>
      JSON.stringify(
        await api.get(`services/${service_id}/config/schema`).json(),
      ),
  },
  {
    name: "get_service_config",
    description: `
    Fetch the current service configuration by service id.

    When to use:
      - Use to inspect the currently stored configuration values.
    When NOT to use:
      - If you need the allowed shape/constraints, call
        \`get_service_config_schema\` instead.
    `,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({ service_id: ServiceId }),
    execute: async ({ service_id }) =>
      JSON.stringify(await api.get(`services/${service_id}/config`).json()),
  },
  {
    name: "patch_service_config",
    description: `
    Patch a service configuration with JSON Patch operations.

    The API applies the patch to the current configuration, validates the
    result against the configuration schema, and persists the resulting object.

    When to use:
      - Use to update one or more config keys without sending the entire object.
    When NOT to use:
      - If you only need to read config, use \`get_service_config\`.
    `,
    annotations: { idempotentHint: false, openWorldHint: true },
    parameters: z.object({
      service_id: ServiceId,
      patch: JsonPatch,
    }),
    execute: async ({ service_id, patch }) =>
      JSON.stringify(
        await api
          .patch(`services/${service_id}/config`, { json: patch })
          .json(),
      ),
  },
  {
    name: "get_service_secrets_schema",
    description: `
    Fetch a service's secrets JSON Schema by service id.

    Stored secret values are encrypted at rest and never returned by the API.

    When to use:
      - Use to learn which secret keys/values a service accepts.
    When NOT to use:
      - If you need to update secrets, call \`patch_service_secrets\` instead.
    `,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({ service_id: ServiceId }),
    execute: async ({ service_id }) =>
      JSON.stringify(
        await api.get(`services/${service_id}/secrets/schema`).json(),
      ),
  },
  {
    name: "patch_service_secrets",
    description: `
    Patch a service secrets payload with JSON Patch operations.

    The API applies the patch to the current (decrypted) secrets, validates the
    result against the secrets schema, and re-encrypts before persisting. Treat
    all values as sensitive; avoid logging them.

    When to use:
      - Use to update one or more secret keys without sending the entire object.
    When NOT to use:
      - If you need to inspect the schema, use \`get_service_secrets_schema\`.
    `,
    annotations: { idempotentHint: false, openWorldHint: true },
    parameters: z.object({
      service_id: ServiceId,
      patch: JsonPatch,
    }),
    execute: async ({ service_id, patch }) =>
      JSON.stringify(
        await api
          .patch(`services/${service_id}/secrets`, { json: patch })
          .json(),
      ),
  },
];
