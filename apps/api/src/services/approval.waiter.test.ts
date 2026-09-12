import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearAllWaiters,
  getWaiterProcessId,
  resolveApprovalWaiter,
  waitForApproval,
} from "@/services/approval.waiter";

describe("approval.waiter", () => {
  beforeEach(() => {
    clearAllWaiters();
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearAllWaiters();
    vi.useRealTimers();
  });

  describe("waitForApproval", () => {
    it("returns a promise that resolves when resolveApprovalWaiter is called", async () => {
      const promise = waitForApproval("apr_test1", 123);
      resolveApprovalWaiter("apr_test1", "approved");
      await expect(promise).resolves.toBe("approved");
    });

    it("resolves with denied state", async () => {
      const promise = waitForApproval("apr_test2", 123);
      resolveApprovalWaiter("apr_test2", "denied");
      await expect(promise).resolves.toBe("denied");
    });

    it("resolves with expired state", async () => {
      const promise = waitForApproval("apr_test3", 123);
      resolveApprovalWaiter("apr_test3", "expired");
      await expect(promise).resolves.toBe("expired");
    });

    it("stores the processId", async () => {
      waitForApproval("apr_test4", 456);
      expect(getWaiterProcessId("apr_test4")).toBe(456);
    });

    it("stores null processId", async () => {
      waitForApproval("apr_test5", null);
      expect(getWaiterProcessId("apr_test5")).toBeNull();
    });

    it("clears waiter after resolution", async () => {
      const promise = waitForApproval("apr_test6", 123);
      resolveApprovalWaiter("apr_test6", "approved");
      await promise;
      expect(getWaiterProcessId("apr_test6")).toBeUndefined();
    });

    it("handles multiple concurrent waiters", async () => {
      const p1 = waitForApproval("apr_1", 1);
      const p2 = waitForApproval("apr_2", 2);
      const p3 = waitForApproval("apr_3", 3);

      resolveApprovalWaiter("apr_2", "denied");
      resolveApprovalWaiter("apr_1", "approved");
      resolveApprovalWaiter("apr_3", "expired");

      await expect(p1).resolves.toBe("approved");
      await expect(p2).resolves.toBe("denied");
      await expect(p3).resolves.toBe("expired");
    });

    it("ignores resolving unknown approval ID", () => {
      expect(() => resolveApprovalWaiter("unknown", "approved")).not.toThrow();
    });

    it("returns undefined for unknown approval ID", () => {
      expect(getWaiterProcessId("unknown")).toBeUndefined();
    });
  });

  describe("resolveApprovalWaiter", () => {
    it("resolves the promise with the provided state", async () => {
      const promise = waitForApproval("apr_resolve1", 1);
      resolveApprovalWaiter("apr_resolve1", "approved");
      await expect(promise).resolves.toBe("approved");
    });

    it("does nothing if waiter not found", () => {
      expect(() =>
        resolveApprovalWaiter("nonexistent", "approved"),
      ).not.toThrow();
    });
  });

  describe("getWaiterProcessId", () => {
    it("returns processId for existing waiter", async () => {
      waitForApproval("apr_get1", 789);
      expect(getWaiterProcessId("apr_get1")).toBe(789);
    });

    it("returns null if processId was null", async () => {
      waitForApproval("apr_get2", null);
      expect(getWaiterProcessId("apr_get2")).toBeNull();
    });

    it("returns undefined for non-existent waiter", () => {
      expect(getWaiterProcessId("nonexistent")).toBeUndefined();
    });
  });

  describe("clearAllWaiters", () => {
    it("clears all waiters", async () => {
      waitForApproval("apr_a", 1);
      waitForApproval("apr_b", 2);
      waitForApproval("apr_c", 3);

      clearAllWaiters();

      expect(getWaiterProcessId("apr_a")).toBeUndefined();
      expect(getWaiterProcessId("apr_b")).toBeUndefined();
      expect(getWaiterProcessId("apr_c")).toBeUndefined();
    });

    it("removes waiters from map without rejecting promises", () => {
      waitForApproval("apr_clear1", 1);
      waitForApproval("apr_clear2", 2);

      clearAllWaiters();

      expect(getWaiterProcessId("apr_clear1")).toBeUndefined();
      expect(getWaiterProcessId("apr_clear2")).toBeUndefined();
    });
  });
});
