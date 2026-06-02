import { type Router as ExpressRouter, Router } from "express";

import {
  createService,
  deleteService,
  getService,
  getServiceConfiguration,
  getServiceConfigurationSchema,
  getServiceSecretsSchema,
  listServices,
  patchServiceConfiguration,
  patchServiceSecrets,
  setServiceEnabled,
  updateService,
} from "@/controllers/service.controller";

export const serviceRouter: ExpressRouter = Router();

serviceRouter.get("/", listServices);
serviceRouter.get("/:serviceId", getService);
serviceRouter.post("/install", createService);
serviceRouter.post("/:serviceId/update", updateService);
serviceRouter.post("/:serviceId/enabled", setServiceEnabled);
serviceRouter.delete("/:serviceId", deleteService);

serviceRouter.get("/:serviceId/config/schema", getServiceConfigurationSchema);
serviceRouter.get("/:serviceId/config", getServiceConfiguration);
serviceRouter.patch("/:serviceId/config", patchServiceConfiguration);

serviceRouter.get("/:serviceId/secrets/schema", getServiceSecretsSchema);
serviceRouter.patch("/:serviceId/secrets", patchServiceSecrets);
