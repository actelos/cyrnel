import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { z } from "zod";
import { ModuleId, ModuleType } from "@/schemas";
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
];
