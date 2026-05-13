import { Router } from "express";

import {
  createService,
  deleteService,
  getService,
  getServiceConfiguration,
  getServiceConfigurationSchema,
  getServiceSecretsSchema,
  getServiceTool,
  listServices,
  listServiceTools,
  patchServiceConfiguration,
  patchServiceSecrets,
  setServiceEnabled,
  setServiceToolEnabled,
  updateService,
} from "@/controllers/service.controller";

export const serviceRouter = Router();

serviceRouter.get("/", listServices);
serviceRouter.get("/:serviceName", getService);
serviceRouter.post("/install", createService);
serviceRouter.post("/:serviceName/update", updateService);
serviceRouter.post("/:serviceName/enabled", setServiceEnabled);
serviceRouter.delete("/:serviceName", deleteService);

serviceRouter.get(
  "/:serviceName/configuration/schema",
  getServiceConfigurationSchema,
);
serviceRouter.get("/:serviceName/configuration", getServiceConfiguration);
serviceRouter.patch("/:serviceName/configuration", patchServiceConfiguration);

serviceRouter.get("/:serviceName/secrets/schema", getServiceSecretsSchema);
serviceRouter.patch("/:serviceName/secrets", patchServiceSecrets);

serviceRouter.get("/:serviceName/tools", listServiceTools);
serviceRouter.get("/:serviceName/tools/:toolName", getServiceTool);
serviceRouter.post(
  "/:serviceName/tools/:toolName/enabled",
  setServiceToolEnabled,
);
