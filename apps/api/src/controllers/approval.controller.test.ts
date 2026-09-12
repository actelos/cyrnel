import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "@/models/error.model";

vi.mock("@/db/client", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            all: vi.fn(),
          })),
        })),
      })),
    })),
  },
}));

vi.mock("@/services/approval.service", () => ({
  listApprovals: vi.fn(),
  getApproval: vi.fn(),
  resolveApproval: vi.fn(),
}));

import {
  approveRequest,
  denyRequest,
  getApprovalRequest,
  listApprovalRequests,
} from "@/controllers/approval.controller";
import { db } from "@/db/client";
import {
  getApproval,
  listApprovals,
  resolveApproval,
} from "@/services/approval.service";

const dbAll = vi.fn();

interface MockResponse {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

const makeRes = (): MockResponse => {
  const res = {} as MockResponse;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.end = vi.fn().mockReturnValue(res);
  res.set = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
};

const makeReq = (overrides: Record<string, unknown> = {}): Request =>
  ({
    app: { locals: {} },
    params: {},
    query: {},
    body: {},
    ...overrides,
  }) as unknown as Request;

const cast = (res: MockResponse) => res as unknown as Response;

describe("approval.controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbAll.mockClear();
    const dbSelect = vi.mocked(db.select);
    dbSelect.mockClear();
    dbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            all: dbAll,
          }),
        }),
      }),
    });
  });

  describe("listApprovalRequests", () => {
    it("returns paginated approvals with default filters", async () => {
      const res = makeRes();
      listApprovals.mockResolvedValue({
        items: [],
        nextCursor: null,
        hasMore: false,
      });

      await listApprovalRequests(makeReq(), cast(res));

      expect(listApprovals).toHaveBeenCalledWith({
        state: undefined,
        serviceId: undefined,
        toolId: undefined,
        processId: undefined,
        limit: 20,
        cursor: undefined,
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        items: [],
        nextCursor: null,
        hasMore: false,
      });
    });

    it("forwards all filter parameters", async () => {
      const res = makeRes();
      listApprovals.mockResolvedValue({
        items: [{ id: "a1" }],
        nextCursor: "cursor-1",
        hasMore: true,
      });

      await listApprovalRequests(
        makeReq({
          query: {
            state: "pending",
            serviceId: "svc-1",
            toolId: "tool-1",
            processId: "42",
            limit: "10",
            cursor: "abc",
          },
        }),
        cast(res),
      );

      expect(listApprovals).toHaveBeenCalledWith({
        state: "pending",
        serviceId: "svc-1",
        toolId: "tool-1",
        processId: 42,
        limit: 10,
        cursor: "abc",
      });
      expect(res.json).toHaveBeenCalledWith({
        items: [{ id: "a1" }],
        nextCursor: "cursor-1",
        hasMore: true,
      });
    });

    it("rejects invalid state", async () => {
      const res = makeRes();
      await expect(
        listApprovalRequests(
          makeReq({ query: { state: "invalid" } }),
          cast(res),
        ),
      ).rejects.toBeInstanceOf(HttpError);
      expect(listApprovals).not.toHaveBeenCalled();
    });

    it("rejects non-positive processId", async () => {
      const res = makeRes();
      await expect(
        listApprovalRequests(makeReq({ query: { processId: "0" } }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
      await expect(
        listApprovalRequests(
          makeReq({ query: { processId: "-1" } }),
          cast(res),
        ),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });

  describe("getApprovalRequest", () => {
    it("returns the approval when found", async () => {
      const res = makeRes();
      const approval = {
        id: "a1",
        serviceId: "svc-1",
        toolId: "tool-1",
        processId: 42,
        parameters: { foo: "bar" },
        state: "pending" as const,
        createdAt: "2024-01-01T00:00:00.000Z",
        expiresAt: Date.now() + 86400000,
        decidedAt: null,
      };
      getApproval.mockResolvedValue(approval);

      await getApprovalRequest(makeReq({ params: { id: "a1" } }), cast(res));

      expect(getApproval).toHaveBeenCalledWith("a1");
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(approval);
    });

    it("passes id as-is to the service (no trimming)", async () => {
      const res = makeRes();
      getApproval.mockResolvedValue({ id: "a1" });

      await getApprovalRequest(
        makeReq({ params: { id: "  a1  " } }),
        cast(res),
      );

      expect(getApproval).toHaveBeenCalledWith("  a1  ");
    });

    it("throws 404 when not found", async () => {
      const res = makeRes();
      getApproval.mockRejectedValue(
        new HttpError(404, `Approval 'missing' not found.`),
      );

      await expect(
        getApprovalRequest(makeReq({ params: { id: "missing" } }), cast(res)),
      ).rejects.toMatchObject({
        statusCode: 404,
        message: "Approval 'missing' not found.",
      });
    });

    it.each(["", "   "])("rejects empty id=%s", async (id) => {
      const res = makeRes();
      await expect(
        getApprovalRequest(makeReq({ params: { id } }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });

  describe("approveRequest", () => {
    it("approves a pending approval and returns it", async () => {
      const res = makeRes();
      resolveApproval.mockResolvedValue({
        resolved: true,
        processId: 42,
        pendingCount: 0,
      });
      const approval = {
        id: "a1",
        state: "approved",
        decidedAt: Date.now(),
      };
      getApproval.mockResolvedValue(approval);

      await approveRequest(makeReq({ params: { id: "a1" } }), cast(res));

      expect(resolveApproval).toHaveBeenCalledWith("a1", "approved");
      expect(getApproval).toHaveBeenCalledWith("a1");
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(approval);
    });

    it("throws 404 when approval does not exist", async () => {
      const res = makeRes();
      resolveApproval.mockResolvedValue({
        resolved: false,
      });
      dbAll.mockResolvedValue([]);

      await expect(
        approveRequest(makeReq({ params: { id: "missing" } }), cast(res)),
      ).rejects.toMatchObject({
        statusCode: 404,
        message: "Approval 'missing' not found.",
      });
    });

    it("throws 409 when already decided (approved)", async () => {
      const res = makeRes();
      resolveApproval.mockResolvedValue({
        resolved: false,
      });
      dbAll.mockResolvedValue([{ state: "approved" }]);

      await expect(
        approveRequest(makeReq({ params: { id: "a1" } }), cast(res)),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "Approval 'a1' is already approved.",
        code: "already_decided",
      });
    });

    it("throws 409 when already decided (denied)", async () => {
      const res = makeRes();
      resolveApproval.mockResolvedValue({
        resolved: false,
      });
      dbAll.mockResolvedValue([{ state: "denied" }]);

      await expect(
        approveRequest(makeReq({ params: { id: "a1" } }), cast(res)),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "already_decided",
      });
    });

    it("rejects empty id", async () => {
      const res = makeRes();
      await expect(
        approveRequest(makeReq({ params: { id: "" } }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });

  describe("denyRequest", () => {
    it("denies a pending approval and returns it", async () => {
      const res = makeRes();
      resolveApproval.mockResolvedValue({
        resolved: true,
        processId: 42,
        pendingCount: 0,
      });
      const approval = {
        id: "a1",
        state: "denied",
        decidedAt: Date.now(),
      };
      getApproval.mockResolvedValue(approval);

      await denyRequest(makeReq({ params: { id: "a1" } }), cast(res));

      expect(resolveApproval).toHaveBeenCalledWith("a1", "denied");
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(approval);
    });

    it("throws 404 when approval does not exist", async () => {
      const res = makeRes();
      resolveApproval.mockResolvedValue({
        resolved: false,
      });
      dbAll.mockResolvedValue([]);

      await expect(
        denyRequest(makeReq({ params: { id: "missing" } }), cast(res)),
      ).rejects.toMatchObject({
        statusCode: 404,
        message: "Approval 'missing' not found.",
      });
    });

    it("throws 409 when already decided", async () => {
      const res = makeRes();
      resolveApproval.mockResolvedValue({
        resolved: false,
      });
      dbAll.mockResolvedValue([{ state: "approved" }]);

      await expect(
        denyRequest(makeReq({ params: { id: "a1" } }), cast(res)),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "already_decided",
      });
    });

    it("rejects empty id", async () => {
      const res = makeRes();
      await expect(
        denyRequest(makeReq({ params: { id: "" } }), cast(res)),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });
});
