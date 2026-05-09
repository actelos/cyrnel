import { Router } from "express";

import {
  createService,
  deleteService,
  getServiceConfiguration,
  getServiceConfigurationSchema,
  getService,
  getToolByName,
  listServices,
  listTools,
  patchServiceConfiguration,
  setServiceEnabled,
  setToolEnabled,
  updateService,
} from "@/controllers/service.controller";

export const serviceRouter = Router();

serviceRouter.get("/", listServices);
serviceRouter.get("/:serviceName", getService);
serviceRouter.get("/:serviceName/configuration", getServiceConfiguration);
serviceRouter.get(
  "/:serviceName/configuration/schema",
  getServiceConfigurationSchema,
);
serviceRouter.patch("/:serviceName/configuration", patchServiceConfiguration);
serviceRouter.post("/install", createService);
serviceRouter.post("/:serviceName/update", updateService);
serviceRouter.post("/:serviceName/enabled", setServiceEnabled);
serviceRouter.delete("/:serviceName", deleteService);

serviceRouter.get("/:serviceName/tools", listTools);
serviceRouter.get("/:serviceName/tools/:toolName", getToolByName);
serviceRouter.post("/:serviceName/tools/:toolName/enabled", setToolEnabled);
