import { type Router as ExpressRouter, Router } from "express";
import {
  approveRequest,
  denyRequest,
  getApprovalRequest,
  listApprovalRequests,
} from "@/controllers/approval.controller";
import { createRateLimiter } from "@/middleware/rate-limit.middleware";

export const approvalRouter: ExpressRouter = Router();

approvalRouter.get(
  "/",
  createRateLimiter(30, 60_000, "GET /approvals"),
  listApprovalRequests,
);
approvalRouter.get("/:id", getApprovalRequest);
approvalRouter.post(
  "/:id/approve",
  createRateLimiter(10, 60_000, "POST /approvals/:id/approve"),
  approveRequest,
);
approvalRouter.post(
  "/:id/deny",
  createRateLimiter(10, 60_000, "POST /approvals/:id/deny"),
  denyRequest,
);
