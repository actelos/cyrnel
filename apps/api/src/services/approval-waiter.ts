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
