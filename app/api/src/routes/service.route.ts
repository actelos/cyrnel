import { Router } from "express";

import {
  createService,
  deleteService,
  getService,
  getToolByName,
  listServices,
  listTools,
  updateService,
} from "@/controllers/service.controller";

export const serviceRouter = Router();

serviceRouter.get("/", listServices);
serviceRouter.get("/:serviceName/tools", listTools);
serviceRouter.get("/:serviceName/tools/:toolName", getToolByName);
serviceRouter.get("/:serviceName", getService);
serviceRouter.post("/:serviceName", createService);
serviceRouter.post("/:serviceName/upgrade", updateService);
serviceRouter.delete("/:serviceName", deleteService);
