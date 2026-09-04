import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { approvalRequests } from "@/db/schema";
import { logger } from "@/infra/logging";
import { HttpError } from "@/models/error.model";
import {
  decodeCursor,
  invalidCursorError,
  keysetConditions,
  PAGINATION_DEFAULT_LIMIT,
  type PaginatedResult,
  paginatePage,
} from "@/utils/pagination.util";

export interface ListApprovalsInput {
  state?: "pending" | "approved" | "denied" | "expired";
  serviceId?: string;
  toolId?: string;
  processId?: number;
  limit?: number;
  cursor?: string;
}

export interface ApprovalRow {
  id: string;
  serviceId: string;
  toolId: string;
  processId: number | null;
  parameters: unknown;
  state: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  expiresAt: number;
  decidedAt: number | null;
}

export async function listApprovals(
  input: ListApprovalsInput,
): Promise<PaginatedResult<ApprovalRow>> {
  const limit = input.limit ?? PAGINATION_DEFAULT_LIMIT;
  const cursor =
    input.cursor !== undefined ? decodeCursor(input.cursor, 2) : undefined;
  let cursorCreatedAt: string | undefined;
  let cursorId: string | undefined;
  const conditions: ReturnType<typeof eq>[] = [];
  if (cursor) {
    const [createdAt, id] = cursor.sortKey;
    if (typeof createdAt !== "string" || typeof id !== "string")
      throw invalidCursorError();
    cursorCreatedAt = createdAt;
    cursorId = id;
    const predicate = keysetConditions(
      [
        [approvalRequests.createdAt, createdAt],
        [approvalRequests.id, id],
      ],
      "before",
    );
    if (predicate) conditions.push(predicate as never);
  }
  if (input.state)
    conditions.push(eq(approvalRequests.state, input.state) as never);
  if (input.serviceId)
    conditions.push(eq(approvalRequests.serviceId, input.serviceId) as never);
  if (input.toolId)
    conditions.push(eq(approvalRequests.toolId, input.toolId) as never);
  if (input.processId !== undefined)
    conditions.push(eq(approvalRequests.processId, input.processId) as never);

  const rows = await db
    .select()
    .from(approvalRequests)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(approvalRequests.createdAt), desc(approvalRequests.id))
    .limit(limit + 1)
    .all()
    .catch(() => {
      throw new HttpError(500, "Failed to list approvals.");
    });

  const items: ApprovalRow[] = await Promise.all(
    rows.map(async (row) => {
      let parameters: unknown = {};
      try {
        const encrypted = JSON.parse(row.parameters) as unknown;
        if (
          encrypted &&
          typeof encrypted === "object" &&
          "ciphertext" in (encrypted as Record<string, unknown>)
        ) {
          try {
            const { decryptSecrets: ds } = await import("@/utils/secrets.util");
            parameters = ds(encrypted as never);
          } catch {
            parameters = {};
          }
        } else {
          parameters = encrypted;
        }
      } catch {
        parameters = {};
      }
      return {
        id: row.id,
        serviceId: row.serviceId,
        toolId: row.toolId,
        processId: row.processId,
        parameters,
        state: row.state as ApprovalRow["state"],
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        decidedAt: row.decidedAt ?? null,
      };
    }),
  );

  let filtered = items;
  if (cursorCreatedAt !== undefined && cursorId !== undefined) {
    const ca = cursorCreatedAt;
    const ci = cursorId;
    filtered = items.filter(
      (row) => row.createdAt < ca || (row.createdAt === ca && row.id < ci),
    );
  }

  return paginatePage(filtered.slice(0, limit + 1), limit, (row) => [
    row.createdAt,
    row.id,
  ]);
}

export async function getApproval(id: string): Promise<ApprovalRow> {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, id))
    .limit(1)
    .all()
    .catch(() => {
      throw new HttpError(500, `Failed to load approval '${id}'.`);
    });
  if (!row) throw new HttpError(404, `Approval '${id}' not found.`);
  let parameters: unknown = {};
  try {
    const encrypted = JSON.parse(row.parameters) as unknown;
    if (
      encrypted &&
      typeof encrypted === "object" &&
      "ciphertext" in (encrypted as Record<string, unknown>)
    ) {
      const { decryptSecrets: ds } = await import("@/utils/secrets.util");
      try {
        parameters = ds(encrypted as never);
      } catch {
        parameters = {};
      }
    } else {
      parameters = encrypted;
    }
  } catch {
    parameters = {};
  }
  return {
    id: row.id,
    serviceId: row.serviceId,
    toolId: row.toolId,
    processId: row.processId,
    parameters,
    state: row.state as ApprovalRow["state"],
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt ?? null,
  };
}

export async function resolveApproval(
  id: string,
  targetState: "approved" | "denied" | "expired",
): Promise<{
  resolved: boolean;
  processId?: number | null;
  pendingCount?: number;
}> {
  return await db
    .transaction(async (tx) => {
      const now = Date.now();
      const expiryPredicate =
        targetState === "expired"
          ? lte(approvalRequests.expiresAt, now)
          : gt(approvalRequests.expiresAt, now);
      const [updated] = await tx
        .update(approvalRequests)
        .set({ state: targetState, decidedAt: now })
        .where(
          and(
            eq(approvalRequests.id, id),
            eq(approvalRequests.state, "pending"),
            expiryPredicate,
          ),
        )
        .returning({ processId: approvalRequests.processId });

      if (!updated) {
        if (targetState !== "expired") {
          const [stale] = await tx
            .select({ id: approvalRequests.id })
            .from(approvalRequests)
            .where(
              and(
                eq(approvalRequests.id, id),
                eq(approvalRequests.state, "pending"),
                lte(approvalRequests.expiresAt, now),
              ),
            )
            .limit(1);
          if (stale) {
            await tx
              .update(approvalRequests)
              .set({ state: "expired", decidedAt: now })
              .where(eq(approvalRequests.id, id));
            try {
              const { resolveApprovalWaiter } = await import(
                "@/services/approval-waiter"
              );
              resolveApprovalWaiter(id, "expired");
            } catch {}
          }
        }
        return { resolved: false };
      }

      const pendingCount =
        updated.processId == null
          ? 0
          : (
              await tx
                .select({ count: sql<number>`count(*)` })
                .from(approvalRequests)
                .where(
                  and(
                    eq(approvalRequests.processId, updated.processId),
                    eq(approvalRequests.state, "pending"),
                  ),
                )
            )[0].count;

      return { resolved: true, processId: updated.processId, pendingCount };
    })
    .then(async (outcome) => {
      if (outcome.resolved) {
        try {
          const { resolveApprovalWaiter } = await import(
            "@/services/approval-waiter"
          );
          resolveApprovalWaiter(id, targetState);
        } catch {}
        if (outcome.processId != null) {
          try {
            const { getProcessService } = await import(
              "@/services/process-holder"
            );
            const ps = getProcessService();
            if (ps) {
              await ps.notifyApprovalResolved(
                outcome.processId,
                outcome.pendingCount ?? 0,
                targetState,
              );
            } else {
              const { db: dbClient } = await import("@/db/client");
              const { processes } = await import("@/db/schema");
              if (outcome.pendingCount === 0) {
                await dbClient
                  .update(processes)
                  .set({ state: "running" })
                  .where(eq(processes.id, outcome.processId))
                  .catch(() => {});
              }
            }
            logger.info(
              {
                event: "approval-resolved",
                approvalId: id,
                targetState,
                processId: outcome.processId,
                pendingCount: outcome.pendingCount,
              },
              "Approval resolved",
            );
          } catch {}
        }
      }
      return outcome;
    });
}

export async function sweepExpiredApprovals(): Promise<number> {
  const now = Date.now();
  const expired = await db
    .update(approvalRequests)
    .set({ state: "expired", decidedAt: now })
    .where(
      and(
        eq(approvalRequests.state, "pending"),
        lte(approvalRequests.expiresAt, now),
      ),
    )
    .returning({
      id: approvalRequests.id,
      processId: approvalRequests.processId,
    })
    .catch(() => [] as { id: string; processId: number | null }[]);
  if (expired.length > 0) {
    logger.info(
      { event: "approval-expiry-sweep", expiredCount: expired.length },
      "Expired approvals swept",
    );
    for (const row of expired) {
      try {
        const { resolveApprovalWaiter } = await import(
          "@/services/approval-waiter"
        );
        resolveApprovalWaiter(row.id, "expired");
      } catch {}
    }
    const distinct = [
      ...new Set(expired.map((r) => r.processId).filter((p) => p != null)),
    ] as number[];
    for (const pid of distinct) {
      try {
        const pending = await db
          .select({ count: sql<number>`count(*)` })
          .from(approvalRequests)
          .where(
            and(
              eq(approvalRequests.processId, pid),
              eq(approvalRequests.state, "pending"),
            ),
          )
          .then((rows) => rows[0].count);
        const { getProcessService } = await import("@/services/process-holder");
        const ps = getProcessService();
        if (ps) {
          await ps.notifyApprovalResolved(pid, pending, "expired");
        } else if (pending === 0) {
          const { processes } = await import("@/db/schema");
          await db
            .update(processes)
            .set({ state: "running" })
            .where(eq(processes.id, pid))
            .catch(() => {});
        }
      } catch {}
    }
  }
  return expired.length;
}

export async function sweepRetention(retentionMs: number): Promise<number> {
  if (retentionMs === 0) return 0;
  const cutoff = Date.now() - retentionMs;
  const deleted = await db
    .delete(approvalRequests)
    .where(
      and(
        inArray(approvalRequests.state, ["approved", "denied", "expired"]),
        lte(approvalRequests.decidedAt, cutoff),
      ),
    )
    .returning({ id: approvalRequests.id })
    .catch(() => [] as { id: string }[]);
  if (deleted.length > 0) {
    logger.info(
      { event: "approval-retention-sweep", prunedCount: deleted.length },
      "Retention sweep pruned approvals",
    );
  }
  return deleted.length;
}
