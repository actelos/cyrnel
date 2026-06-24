import { type Router as ExpressRouter, Router } from "express";

import {
  createServiceDirect,
  deleteService,
  getService,
  getServiceConfiguration,
  getServiceConfigurationSchema,
  getServiceSecrets,
  getServiceSecretsSchema,
  installServiceRegistry,
  listServices,
  patchService,
  patchServiceConfiguration,
  patchServiceSecrets,
  setServiceEnabled,
  syncService,
  updateService,
} from "@/controllers/service.controller";

export const serviceRouter: ExpressRouter = Router();

serviceRouter.get("/", listServices);
serviceRouter.get("/:serviceId", getService);
serviceRouter.post("/", createServiceDirect);
serviceRouter.post("/install", installServiceRegistry);
serviceRouter.post("/:serviceId/update", updateService);
serviceRouter.post("/:serviceId/sync", syncService);
serviceRouter.patch("/:serviceId", patchService);
serviceRouter.post("/:serviceId/enabled", setServiceEnabled);
serviceRouter.delete("/:serviceId", deleteService);

serviceRouter.get("/:serviceId/config/schema", getServiceConfigurationSchema);
serviceRouter.get("/:serviceId/config", getServiceConfiguration);
serviceRouter.patch("/:serviceId/config", patchServiceConfiguration);

serviceRouter.get("/:serviceId/secrets", getServiceSecrets);
serviceRouter.get("/:serviceId/secrets/schema", getServiceSecretsSchema);
serviceRouter.patch("/:serviceId/secrets", patchServiceSecrets);
