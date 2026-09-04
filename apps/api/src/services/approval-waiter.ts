type Waiter = {
  resolve: (state: "approved" | "denied" | "expired") => void;
  processId: number | null;
};

const waiters = new Map<string, Waiter>();

export function waitForApproval(
  approvalId: string,
  processId: number | null,
): Promise<"approved" | "denied" | "expired"> {
  return new Promise((resolve) => {
    waiters.set(approvalId, { resolve, processId });
    // Race check: if approval was already resolved between insert and waiter registration, settle immediately
    void (async () => {
      try {
        const { db } = await import("@/db/client");
        const { approvalRequests } = await import("@/db/schema");
        const { eq } = await import("drizzle-orm");
        const [row] = await db
          .select({ state: approvalRequests.state })
          .from(approvalRequests)
          .where(eq(approvalRequests.id, approvalId))
          .limit(1)
          .all();
        if (row && row.state !== "pending") {
          const waiter = waiters.get(approvalId);
          if (waiter) {
            waiter.resolve(row.state as "approved" | "denied" | "expired");
            waiters.delete(approvalId);
          }
        }
      } catch {}
    })();
  });
}

export function resolveApprovalWaiter(
  approvalId: string,
  state: "approved" | "denied" | "expired",
): void {
  const waiter = waiters.get(approvalId);
  if (waiter) {
    waiter.resolve(state);
    waiters.delete(approvalId);
  }
}

export function getWaiterProcessId(
  approvalId: string,
): number | null | undefined {
  return waiters.get(approvalId)?.processId;
}

export function clearAllWaiters(): void {
  waiters.clear();
}
