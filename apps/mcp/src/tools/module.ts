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
    Install a module by resolving a registry source URL.

    Fetches the registry metadata API at \`source\`, resolves the download URL
    and optional hash, then validates the archive hash (if provided) before
    extracting and registering the module. Newly installed modules start
    disabled by default.

    When to use:
      - Use to install an adapter or environment module from a module registry.
    When NOT to use:
      - For a direct .tar.zst URL, use \`add_module\` instead.
    `,
    annotations: { destructiveHint: true, idempotentHint: false },
    parameters: z.object({
      source: z
        .string()
        .min(1)
        .describe(
          'Registry URL that returns module metadata { downloadUrl, hash? }. Example: "https://registry.example.com/modules/my-module".',
        ),
    }),
    execute: async ({ source }) =>
      JSON.stringify(
        await api.post("modules/install", { json: { source } }).json(),
      ),
  },
  {
    name: "add_module",
    description: `
    Install a new module directly from a compressed tar archive (.tar.zst) URL.

    Downloads the archive, validates its module.json manifest, and registers
    the module. No registry resolution — the URL must point directly at a
    .tar.zst file. Newly installed modules start disabled by default.

    When to use:
      - Use to install an adapter or environment module from a direct download
        URL without a registry.
    When NOT to use:
      - To install via a module registry, use \`install_module\` instead.
    `,
    annotations: { destructiveHint: true, idempotentHint: false },
    parameters: z.object({
      url: z
        .string()
        .min(1)
        .describe(
          'Direct URL of the .tar.zst archive. Example: "https://example.com/module.tar.zst".',
        ),
    }),
    execute: async ({ url }) =>
      JSON.stringify(await api.post("modules", { json: { url } }).json()),
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
    Re-resolve the stored registry source URL and re-install if changed.

    Compares the registry's current hash against the stored hash. If unchanged
    the update is skipped. Requires a registry-installed module (source !== "").

    When to use:
      - Use to pull the latest version of a registry-installed module.
    When NOT to use:
      - For a direct-installed module (no registry source), use \`patch_module\`
        instead.
    `,
    annotations: { idempotentHint: true, openWorldHint: true },
    parameters: z.object({ module_id: ModuleId }),
    execute: async ({ module_id }) =>
      JSON.stringify(
        await api.post(`modules/${module_id}/update`, { json: {} }).json(),
      ),
  },
  {
    name: "patch_module",
    description: `
    Replace a module with a new archive from a direct .tar.zst URL.

    Downloads the new archive, replaces the module directory, updates the
    database record, and clears any stored registry source. The module is
    reloaded with the new factory.

    When to use:
      - Use to update a direct-installed module from a new URL.
    When NOT to use:
      - For a registry-installed module, use \`update_module\` instead.
    `,
    annotations: { idempotentHint: false },
    parameters: z.object({
      module_id: ModuleId,
      url: z
        .string()
        .min(1)
        .describe(
          'Direct URL of the new .tar.zst archive. Example: "https://example.com/module-v2.tar.zst".',
        ),
    }),
    execute: async ({ module_id, url }) =>
      JSON.stringify(
        await api.patch(`modules/${module_id}`, { json: { url } }).json(),
      ),
  },
];
