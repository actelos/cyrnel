import { type Router as ExpressRouter, Router } from "express";

import { getEnvironmentDocs } from "@/controllers/environment.controller";
import { createRateLimiter } from "@/middleware/rate-limit.middleware";

export const environmentRouter: ExpressRouter = Router();

environmentRouter.get(
  "/docs",
  createRateLimiter(30, 60_000, "GET /environment/docs"),
  getEnvironmentDocs,
);
