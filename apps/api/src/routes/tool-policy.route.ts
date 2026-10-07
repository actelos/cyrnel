import { type Router as ExpressRouter, Router } from "express";

import {
  createToolPolicyRule,
  deleteToolPolicyRule,
  getAffectedTools,
  listToolPolicyRules,
  previewToolPolicyPattern,
  reorderToolPolicyRules,
  updateToolPolicyRule,
} from "@/controllers/tool-policy.controller";
import { createRateLimiter } from "@/middleware/rate-limit.middleware";

export const toolPolicyRouter: ExpressRouter = Router();

toolPolicyRouter.get("/", listToolPolicyRules);
toolPolicyRouter.post(
  "/",
  createRateLimiter(10, 60_000, "POST /tool-policies"),
  createToolPolicyRule,
);
toolPolicyRouter.get("/preview", previewToolPolicyPattern);
toolPolicyRouter.put(
  "/order",
  createRateLimiter(10, 60_000, "PUT /tool-policies/order"),
  reorderToolPolicyRules,
);
toolPolicyRouter.patch(
  "/:id",
  createRateLimiter(10, 60_000, "PATCH /tool-policies/:id"),
  updateToolPolicyRule,
);
toolPolicyRouter.delete(
  "/:id",
  createRateLimiter(10, 60_000, "DELETE /tool-policies/:id"),
  deleteToolPolicyRule,
);
toolPolicyRouter.get("/:id/affected-tools", getAffectedTools);
