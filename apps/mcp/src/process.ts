import type { Context, FastMCPSessionAuth } from "fastmcp";
import type {
  McpApprovalPresenter,
  PresentInput,
} from "@/approval-presenter.js";
import { listAllPendingApprovals } from "@/approvals.js";
import { api } from "@/fetch.js";
import type { ProcessState } from "@/schemas.js";

export interface ProcessRecord {
  id: number;
  state: ProcessState;
  pendingApprovalIds?: string[];
  [key: string]: unknown;
}

export interface WaitProcessOptions {
  timeoutS?: number;
  ctx?: Context<FastMCPSessionAuth>;
  presenter?: McpApprovalPresenter;
  pollIntervalMs?: number;
  /**
   * Overrides how long one in-band approval prompt may hold the request open.
   * Defaults to APPROVAL_WAIT_BUDGET_MS; tests use a small value.
   */
  approvalWaitBudgetMs?: number;
}

const SUSPENDED_CEILING_MS = 10 * 60_000;
const MAX_POLL_INTERVAL_MS = 5000;

/**
 * How long one in-band approval prompt may hold the MCP request open.
 *
 * This must stay below the MCP client's own request timeout. When a client
 * gives up first, the caller loses the process id along with the response and
 * the process is orphaned in `suspended`. Bounding the wait turns that failure
 * into a normal `{ state: "suspended", pendingApprovalIds }` reply the caller can
 * act on.
 *
 * Answering after this budget is not a failure: the prompt stays outstanding and
 * a late reply still resolves the approval through the approvals API.
 */
const APPROVAL_WAIT_BUDGET_MS = 25_000;

class WaitBudgetExceeded extends Error {}

export async function getProcess(id: number): Promise<ProcessRecord> {
  return (await api.get(`processes/${id}`).json()) as ProcessRecord;
}

/**
 * Blocks until a process settles, routing any approval suspensions through the
 * configured presenter.
 *
 * Time the user spends answering an approval is excluded from both deadlines:
 * it is neither the process running nor a stalled wait, so a slow human
 * decision must not consume the process's execution budget.
 */
export async function waitForProcess(
  id: number,
  options: WaitProcessOptions = {},
): Promise<ProcessRecord> {
  const { ctx, presenter, pollIntervalMs = 100 } = options;
  const approvalBudget =
    options.approvalWaitBudgetMs ?? APPROVAL_WAIT_BUDGET_MS;
  const startedAt = Date.now();
  // Three distinct budgets, deliberately not collapsed into one number:
  //   runDeadline          - how long the process itself may run (timeoutS)
  //   suspendedDeadline    - how long a non-approval suspension may persist
  //   APPROVAL_WAIT_BUDGET_MS - how long one in-band prompt may block the request
  const runDeadline = startedAt + (options.timeoutS ?? 30) * 1000 + 1000;
  const suspendedDeadline = startedAt + SUSPENDED_CEILING_MS;
  let pausedMs = 0;
  let attempt = 0;

  while (true) {
    const process = await getProcess(id);
    if (process.state === "idle" || process.state === "terminated") {
      return process;
    }

    if (process.state === "suspended") {
      // `suspended` is not by itself an approval: only pending approval records
      // make it actionable, and any other suspension keeps its own bound.
      const approvals = await listAllPendingApprovals(id);
      if (approvals.length > 0) {
        if (!presenter?.inBand || !ctx) return process;
        const pausedAt = Date.now();
        const answered = await presentWithinBudget(
          presenter,
          { processId: id, approvals, ctx },
          approvalBudget,
        );
        if (!answered) {
          // Hand the suspended process back instead of holding the request
          // open; the caller keeps the id and can poll again.
          return process;
        }
        pausedMs += Date.now() - pausedAt;
        attempt = 0;
        continue;
      }
      if (Date.now() - pausedMs >= suspendedDeadline) return process;
    } else if (Date.now() - pausedMs >= runDeadline) {
      throw new Error(
        `Process ${id} did not become idle within the configured wait window.`,
      );
    }

    attempt++;
    const delay = Math.min(
      pollIntervalMs * 1.5 ** (attempt - 1),
      MAX_POLL_INTERVAL_MS,
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * Runs one presentation round, giving up after APPROVAL_WAIT_BUDGET_MS.
 *
 * Returns false when the budget ran out with the prompt still outstanding. The
 * prompt itself is left in flight on purpose: a late answer still resolves the
 * approval through the API, and its rejection is absorbed so it cannot surface
 * as an unhandled rejection once we have stopped awaiting it.
 */
async function presentWithinBudget(
  presenter: McpApprovalPresenter,
  input: PresentInput,
  budgetMs: number = APPROVAL_WAIT_BUDGET_MS,
): Promise<boolean> {
  const presented = presenter.present(input);
  presented.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      presented,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new WaitBudgetExceeded()), budgetMs);
      }),
    ]);
    return true;
  } catch (err) {
    if (err instanceof WaitBudgetExceeded) return false;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
