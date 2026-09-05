import { type Router as ExpressRouter, Router } from "express";

import {
  getTool,
  getToolDocs,
  listTools,
  setToolPolicy,
} from "@/controllers/tool.controller";

export const toolRouter: ExpressRouter = Router();

toolRouter.get("/", listTools);
toolRouter.get("/:serviceId/:toolId", getTool);
toolRouter.get("/:serviceId/:toolId/docs", getToolDocs);
toolRouter.put("/:serviceId/:toolId/policy", setToolPolicy);
