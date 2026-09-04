import { type Router as ExpressRouter, Router } from "express";

import {
  getTool,
  getToolDocs,
  getToolPolicy,
  listTools,
  setToolEnabled,
  setToolPolicy,
} from "@/controllers/tool.controller";

export const toolRouter: ExpressRouter = Router();

toolRouter.get("/", listTools);
toolRouter.get("/:serviceId/:toolId", getTool);
toolRouter.get("/:serviceId/:toolId/docs", getToolDocs);
toolRouter.post("/:serviceId/:toolId/enabled", setToolEnabled);
toolRouter.get("/:serviceId/:toolId/policy", getToolPolicy);
toolRouter.put("/:serviceId/:toolId/policy", setToolPolicy);
