import { Router } from "express";

import {
  createService,
  deleteService,
  getService,
  getToolByName,
  listServices,
  listTools,
  setServiceEnabled,
  setToolEnabled,
} from "@/controllers/service.controller";

export const serviceRouter = Router();

serviceRouter.get("/", listServices);
serviceRouter.get("/:serviceName/tools", listTools);
serviceRouter.get("/:serviceName/tools/:toolName", getToolByName);
serviceRouter.post("/:serviceName/tools/:toolName/enabled", setToolEnabled);
serviceRouter.get("/:serviceName", getService);
serviceRouter.post("/:serviceName", createService);
serviceRouter.post("/:serviceName/enabled", setServiceEnabled);
serviceRouter.delete("/:serviceName", deleteService);
