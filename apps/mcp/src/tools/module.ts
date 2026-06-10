import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { z } from "zod";
import { JsonPatch, ModuleId, ModuleType } from "@/schemas.js";
import { api, searchParams } from "@/utils/fetch.js";

// biome-ignore lint/suspicious/noExplicitAny: tool params vary per entry
export const moduleTools: Tool<FastMCPSessionAuth, z.ZodType<any>>[] = [
  {
    name: "list_modules",
    description: `
    List registered adapter and environment modules with optional filters.

    Modules are the pluggable runtime pieces the API depends on:
      - \`adapter\` modules generate service definitions from a manifest source.
      - \`environment\` modules execute process code (only one active).

    When to use:
      - Use to inventory installed modules, find a specific adapter to pass to
        \`create_service\`, or check which environment is currently enabled.
    When NOT to use:
      - If you already know a module id, call \`get_module\` instead.
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
        .describe('Optional search string. Example: "openapi".'),
      type: ModuleType.optional().describe(
        'Optional module type filter. One of "adapter" or "environment".',
      ),
      is_builtin: z.boolean().optional().describe("Optional builtin filter."),
      enabled: z.boolean().optional().describe("Optional enabled filter."),
    }),
    execute: async ({ query, type, is_builtin, enabled }) =>
      JSON.stringify(
        await api
          .get("modules", {
            searchParams: searchParams({
              query,
              type,
              isBuiltin: is_builtin,
              enabled,
            }),
          })
          .json(),
      ),
  },
  {
    name: "get_module",
    description: `
    Fetch a single module manifest by exact id, returning its full metadata.

    When to use:
      - Use when you already know the exact module id and want the current
        enabled/orphaned state or description.
    When NOT to use:
      - If you only have a partial match, call \`list_modules\` first.
    `,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({ module_id: ModuleId }),
    execute: async ({ module_id }) =>
      JSON.stringify(await api.get(`modules/${module_id}`).json()),
  },
  {
    name: "set_module_enabled",
    description: `
    Enable or disable a module by id.

    Enabling an \`environment\` module deactivates any other currently active
    environment module. Orphaned modules cannot be enabled — the API will
    return 409.

    When to use:
      - Use to switch the active environment, or to turn an adapter on/off.
    When NOT to use:
      - If you need to refresh module registration after dropping new modules
        onto disk, call \`reload_modules\` instead.
    `,
    annotations: { idempotentHint: true, openWorldHint: true },
    parameters: z.object({
      module_id: ModuleId,
      enabled: z
        .boolean()
        .describe("Desired enabled state for the module. Example: true."),
    }),
    execute: async ({ module_id, enabled }) =>
      JSON.stringify(
        await api
          .post(`modules/${module_id}/enabled`, { json: { enabled } })
          .json(),
      ),
  },
  {
    name: "reload_modules",
    description: `
    Re-scan the modules directory and reconcile the module registry.

    Re-registers all builtin and on-disk modules, marks any rows whose factories
    disappeared as orphaned, and clears the orphaned flag for any rows whose
    factories have returned.

    When to use:
      - Use after adding or removing modules from disk so the API picks them up
        without a restart.
    When NOT to use:
      - If you just want to toggle a module on/off, use \`set_module_enabled\`.
    `,
    annotations: { idempotentHint: false, openWorldHint: true },
    parameters: z.object({}),
    execute: async () =>
      JSON.stringify(await api.post("modules/reload", { json: {} }).json()),
  },
  {
    name: "get_module_config_schema",
    description: `
    Fetch a module's configuration JSON Schema by module id.

    When to use:
      - Use to learn which configuration keys/values a module accepts before
        patching its configuration.
    When NOT to use:
      - If you need the currently stored configuration values, call
        \`get_module_config\` instead.
    `,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({ module_id: ModuleId }),
    execute: async ({ module_id }) =>
      JSON.stringify(
        await api.get(`modules/${module_id}/config/schema`).json(),
      ),
  },
  {
    name: "get_module_config",
    description: `
    Fetch the current module configuration by module id.

    When to use:
      - Use to inspect the currently stored configuration values for an
        adapter or environment module.
    When NOT to use:
      - If you need the allowed shape/constraints, call
        \`get_module_config_schema\` instead.
    `,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({ module_id: ModuleId }),
    execute: async ({ module_id }) =>
      JSON.stringify(await api.get(`modules/${module_id}/config`).json()),
  },
  {
    name: "patch_module_config",
    description: `
    Patch a module configuration with JSON Patch operations.

    The API applies the patch to the current configuration, validates the
    result against the module's configuration schema, persists it, and reloads
    the active module instance when required.

    When to use:
      - Use to update one or more module config keys without sending the entire
        object.
    When NOT to use:
      - If you only need to read config, use \`get_module_config\`.
    `,
    annotations: { idempotentHint: false, openWorldHint: true },
    parameters: z.object({
      module_id: ModuleId,
      patch: JsonPatch,
    }),
    execute: async ({ module_id, patch }) =>
      JSON.stringify(
        await api.patch(`modules/${module_id}/config`, { json: patch }).json(),
      ),
  },
  {
    name: "get_module_secrets_schema",
    description: `
    Fetch a module's secrets JSON Schema by module id.

    Stored secret values are encrypted at rest and never returned by the API.

    When to use:
      - Use to learn which secret keys/values a module accepts.
    When NOT to use:
      - If you need to update secrets, call \`patch_module_secrets\` instead.
    `,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({ module_id: ModuleId }),
    execute: async ({ module_id }) =>
      JSON.stringify(
        await api.get(`modules/${module_id}/secrets/schema`).json(),
      ),
  },
  {
    name: "patch_module_secrets",
    description: `
    Patch a module secrets payload with JSON Patch operations.

    The API applies the patch to the current decrypted secrets, validates the
    result against the module's secrets schema, re-encrypts it before
    persisting, and reloads the active module instance when required. Treat all
    values as sensitive; avoid logging them.

    When to use:
      - Use to update one or more module secret keys without sending the entire
        object.
    When NOT to use:
      - If you need to inspect the schema, use \`get_module_secrets_schema\`.
    `,
    annotations: { idempotentHint: false, openWorldHint: true },
    parameters: z.object({
      module_id: ModuleId,
      patch: JsonPatch,
    }),
    execute: async ({ module_id, patch }) =>
      JSON.stringify(
        await api.patch(`modules/${module_id}/secrets`, { json: patch }).json(),
      ),
  },
  {
    name: "install_module",
    description: `
    Install a new module from a compressed tar archive (.tar.zst) URL.

    Downloads the archive, validates its module.json manifest, and registers
    the module. Newly installed modules start disabled by default.

    When to use:
      - Use to add a new adapter or environment module from a remote URL.
    When NOT to use:
      - If you already know the module id, use \`get_module\` for details.
    `,
    annotations: { destructiveHint: true, idempotentHint: false },
    parameters: z.object({
      source: z
        .string()
        .min(1)
        .describe(
          'URL of the .tar.zst archive. Example: "https://example.com/module.tar.zst".',
        ),
    }),
    execute: async ({ source }) =>
      JSON.stringify(
        await api.post("modules/install", { json: { source } }).json(),
      ),
  },
  {
    name: "delete_module",
    description: `
    Remove a module by id from the registry and disk.

    Deactivates the adapter or environment, deletes the database record,
    and removes the module's filesystem directory. Services belonging to
    the module are also removed.

    When to use:
      - Use to permanently remove a module that is no longer needed.
    When NOT to use:
      - If you only want to turn the module off, use \`set_module_enabled\`
        with enabled=false instead.
    `,
    annotations: { destructiveHint: true, idempotentHint: true },
    parameters: z.object({ module_id: ModuleId }),
    execute: async ({ module_id }) => {
      await api.delete(`modules/${module_id}`).text();
      return "Module deleted successfully.";
    },
  },
  {
    name: "update_module",
    description: `
    Re-download and re-install a module from its stored source URL.

    Compares the new archive hash against the stored hash. If unchanged the
    update is skipped. If changed, the module directory and database record
    are refreshed and the module instance is reloaded.

    When to use:
      - Use to pull the latest version of a previously installed module.
    When NOT to use:
      - If the module is not yet installed, use \`install_module\` instead.
    `,
    annotations: { idempotentHint: true, openWorldHint: true },
    parameters: z.object({ module_id: ModuleId }),
    execute: async ({ module_id }) =>
      JSON.stringify(
        await api.post(`modules/${module_id}/update`, { json: {} }).json(),
      ),
  },
];
