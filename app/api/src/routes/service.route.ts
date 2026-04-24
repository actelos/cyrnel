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
  updateService,
} from "@/controllers/service.controller";

export const serviceRouter = Router();

serviceRouter.get("/", listServices);
serviceRouter.post("/install", createService);
serviceRouter.post("/:serviceName/update", updateService);
serviceRouter.get("/:serviceName", getService);
serviceRouter.post("/:serviceName/enabled", setServiceEnabled);
serviceRouter.delete("/:serviceName", deleteService);

serviceRouter.get("/:serviceName/tools", listTools);
serviceRouter.get("/:serviceName/tools/:toolName", getToolByName);
serviceRouter.post("/:serviceName/tools/:toolName/enabled", setToolEnabled);
