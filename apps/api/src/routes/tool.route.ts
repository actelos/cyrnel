import { type Router as ExpressRouter, Router } from "express";

import {
  getTool,
  getToolDocs,
  listTools,
  setToolPolicy,
} from "@/controllers/tool.controller";
import { createRateLimiter } from "@/middleware/rate-limit.middleware";

export const toolRouter: ExpressRouter = Router();

toolRouter.get("/", createRateLimiter(30, 60_000, "GET /tools"), listTools);
toolRouter.get("/:serviceId/:toolId", getTool);
toolRouter.get("/:serviceId/:toolId/docs", getToolDocs);
toolRouter.put(
  "/:serviceId/:toolId/policy",
  createRateLimiter(10, 60_000, "PUT /tools/:serviceId/:toolId/policy"),
  setToolPolicy,
);
