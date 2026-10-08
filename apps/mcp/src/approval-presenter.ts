import type { Context, FastMCPSessionAuth } from "fastmcp";
import { UserError } from "fastmcp";
import {
  decideApproval,
  type PendingApproval,
  summarizeParameters,
} from "@/approvals.js";
import type { McpApprovalMethod } from "@/config.js";
import { logger } from "@/logger.js";

type ElicitFn = Context<FastMCPSessionAuth>["elicit"];
type ElicitResult = Awaited<ReturnType<ElicitFn>>;

export interface PresentInput {
  processId: number;
  approvals: PendingApproval[];
  ctx: Context<FastMCPSessionAuth>;
}

export interface McpApprovalPresenter {
  readonly method: McpApprovalMethod;
  /**
   * Whether this presenter resolves approvals inside the blocking tool call.
   * When false the wait loop hands the suspended process back to the caller.
   */
  readonly inBand: boolean;
  present(input: PresentInput): Promise<void>;
}

function buildMessage(approval: PendingApproval): string {
  return [
    `Approve tool call ${approval.serviceId}.${approval.toolId}?`,
    `Process: ${approval.processId ?? "unknown"}`,
    `Parameters: ${summarizeParameters(approval.parameters)}`,
  ].join("\n");
}

function isMissingElicitationSupport(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /does not support (?:form|url) elicitation/i.test(message);
}

/**
 * Drives `elicitation/create` rounds, one per pending approval, resolving each
 * through the approvals API so the API stays the sole decision authority.
 *
 * The elicitation payload carries only a boolean, so a response can never name
 * an approval id; which record a decision applies to is fixed by this server
 * before the request is sent.
 */
export class ElicitationApprovalPresenter implements McpApprovalPresenter {
  readonly method = "elicitation" as const;
  readonly inBand = true;

  async present({ processId, approvals, ctx }: PresentInput): Promise<void> {
    for (const approval of approvals) {
      if (ctx.signal.aborted) {
        throw new UserError(
          `Approval request for ${approval.serviceId}.${approval.toolId} was aborted before it was answered.`,
        );
      }

      let result: ElicitResult;
      try {
        result = await ctx.elicit({
          mode: "form",
          message: buildMessage(approval),
          requestedSchema: {
            type: "object",
            properties: {
              approved: {
                type: "boolean",
                title: "Approve",
                description: `Approve ${approval.serviceId}.${approval.toolId} to run. Leave unchecked, decline, or cancel to deny it.`,
              },
            },
            required: ["approved"],
          },
        });
      } catch (err) {
        if (isMissingElicitationSupport(err)) {
          throw new UserError(
            [
              `Process ${processId} needs approval for ${approval.serviceId}.${approval.toolId}, but this MCP client does not support elicitation (it must advertise \`elicitation: { form: {} }\`).`,
              `Either decide it directly via the API (POST /approvals/${approval.id}/approve or /deny), or set CYRNEL_MCP_APPROVAL_METHOD=manual and use the approval tools.`,
            ].join(" "),
          );
        }
        throw err;
      }

      if (result.action === "cancel") {
        // Cancel leaves the approval pending; do not call decideApproval.
        logger.info(
          {
            event: "mcp-approval-cancelled",
            processId,
            approvalId: approval.id,
            serviceId: approval.serviceId,
            toolId: approval.toolId,
          },
          "MCP approval cancelled, leaving pending",
        );
        continue;
      }

      // `decline` means "do not run this"; map to denial so the suspended
      // process resumes immediately instead of parking until the approval expires.
      // Only `accept` with explicit `approved: true` approves; anything else denies.
      const approved =
        result.action === "accept" && result.content?.approved === true;
      const outcome = await decideApproval(
        approval.id,
        approved ? "approve" : "deny",
      );
      logger.info(
        {
          event: "mcp-approval-decided",
          processId,
          approvalId: approval.id,
          serviceId: approval.serviceId,
          toolId: approval.toolId,
          action: result.action,
          approved,
          outcome,
        },
        "MCP approval decided",
      );
    }
  }
}

/**
 * Leaves approvals pending so the model can decide them explicitly through the
 * approval tools. The wait loop returns the suspended process instead of
 * spinning until the approval expires.
 */
export class ManualApprovalPresenter implements McpApprovalPresenter {
  readonly method = "manual" as const;
  readonly inBand = false;

  async present(): Promise<void> {
    throw new Error(
      "Manual approval presenter cannot resolve approvals in-band.",
    );
  }
}

export function createApprovalPresenter(
  method: McpApprovalMethod,
): McpApprovalPresenter {
  return method === "manual"
    ? new ManualApprovalPresenter()
    : new ElicitationApprovalPresenter();
}
