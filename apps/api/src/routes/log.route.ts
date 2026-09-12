import { type Router as ExpressRouter, Router } from "express";

import { listLogs, streamLogs } from "@/controllers/log.controller";
import { createRateLimiter } from "@/middleware/rate-limit.middleware";

export const logRouter: ExpressRouter = Router();

logRouter.get("/", createRateLimiter(20, 60_000, "GET /logs"), listLogs);
logRouter.get(
  "/stream",
  createRateLimiter(5, 60_000, "GET /logs/stream"),
  streamLogs,
);
