import { z } from "zod";

/**
 * How pending tool approvals are surfaced to MCP clients.
 *
 * - `elicitation`: the blocking tool call drives `elicitation/create` rounds
 *   itself, so the model never orchestrates approvals explicitly.
 * - `manual`: the blocking tool call hands suspended processes back to the
 *   model, which decides via the `list_pending_approvals` / `approve_approval`
 *   / `deny_approval` tools.
 *
 * Either way the approval and policy machinery in the API is unchanged; this
 * only decides how the MCP layer presents it.
 */
export const McpApprovalMethod = z.enum(["elicitation", "manual"]);
export type McpApprovalMethod = z.infer<typeof McpApprovalMethod>;

const env = z
  .object({
    CYRNEL_MCP_APPROVAL_METHOD: McpApprovalMethod.default("elicitation"),
  })
  .parse(process.env);

export const config = {
  approvalMethod: env.CYRNEL_MCP_APPROVAL_METHOD,
} as const;
