import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { z } from "zod";

import { ServiceId, ToolId } from "@/schemas";
import { api, searchParams } from "@/utils/fetch";

// biome-ignore lint/suspicious/noExplicitAny: tool params vary per entry
export const toolTools: Tool<FastMCPSessionAuth, z.ZodType<any>>[] = [
  {
    name: "list_tools",
    description: `
    List tools across services with optional query/limit/enabled filters.

    The returned items include \`effectivelyEnabled\`, which is true only when
    both the tool itself and its owning service are enabled.

    When to use:
      - Use to find candidate tools across one or all services.
    When NOT to use:
      - If you already know the exact service id + tool id, call \`get_tool\`
        instead.
    `,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      service_id: z
        .string()
        .min(1)
        .optional()
        .describe('Optional service id filter. Example: "github".'),
      query: z
        .string()
        .optional()
        .describe('Optional search string. Example: "issues".'),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Optional maximum number of results to return. Example: 10."),
      enabled: z.boolean().optional().describe("Optional enabled filter."),
    }),
    execute: async ({ service_id, query, limit, enabled }) =>
      JSON.stringify(
        await api
          .get("tools", {
            searchParams: searchParams({
              serviceId: service_id,
              query,
              limit,
              enabled,
            }),
          })
          .json(),
      ),
  },
  {
    name: "get_tool",
    description: `
    Fetch a tool definition by service id and tool id, returning schemas.

    When to use:
      - Use when you need the tool's input/output schema before invoking it.
    When NOT to use:
      - If you don't know the tool id yet, call \`list_tools\` first.
    `,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      service_id: ServiceId,
      tool_id: ToolId,
    }),
    execute: async ({ service_id, tool_id }) =>
      JSON.stringify(await api.get(`tools/${service_id}/${tool_id}`).json()),
  },
  {
    name: "set_tool_enabled",
    description: `
    Enable or disable a specific tool within a service.

    Note: even if a tool is enabled, it is only effectively callable when its
    owning service is also enabled.

    When to use:
      - Use to toggle a specific tool on/off without uninstalling the service.
    When NOT to use:
      - If you need to enable/disable the whole service, use
        \`set_service_enabled\` instead.
    `,
    annotations: { idempotentHint: true, openWorldHint: true },
    parameters: z.object({
      service_id: ServiceId,
      tool_id: ToolId,
      enabled: z
        .boolean()
        .describe("Desired enabled state for the tool. Example: false."),
    }),
    execute: async ({ service_id, tool_id, enabled }) =>
      JSON.stringify(
        await api
          .post(`tools/${service_id}/${tool_id}/enabled`, {
            json: { enabled },
          })
          .json(),
      ),
  },
];
