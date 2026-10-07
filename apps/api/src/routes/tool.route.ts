import { type Router as ExpressRouter, Router } from "express";

import {
  getTool,
  getToolDocs,
  invokeTool,
  listTools,
} from "@/controllers/tool.controller";
import { createRateLimiter } from "@/middleware/rate-limit.middleware";

export const toolRouter: ExpressRouter = Router();

toolRouter.get("/", createRateLimiter(30, 60_000, "GET /tools"), listTools);
toolRouter.get("/:serviceId/:toolId", getTool);
toolRouter.get("/:serviceId/:toolId/docs", getToolDocs);
toolRouter.post(
  "/:serviceId/:toolId/invoke",
  createRateLimiter(20, 60_000, "POST /tools/:serviceId/:toolId/invoke"),
  invokeTool,
);
