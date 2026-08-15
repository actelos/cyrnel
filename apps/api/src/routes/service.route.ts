import { type Router as ExpressRouter, Router } from "express";

import {
  createServiceDirect,
  deleteService,
  getService,
  getServiceConfiguration,
  getServiceConfigurationSchema,
  getServiceIcon,
  getServiceSecrets,
  getServiceSecretsSchema,
  installServiceRegistry,
  listInstallAdapters,
  listServices,
  patchService,
  patchServiceConfiguration,
  patchServiceSecrets,
  setServiceEnabled,
  syncService,
  updateService,
} from "@/controllers/service.controller";
import { createRateLimiter } from "@/middleware/rate-limit.middleware";

export const serviceRouter: ExpressRouter = Router();

serviceRouter.get("/", listServices);
serviceRouter.get("/:serviceId", getService);
serviceRouter.get("/:serviceId/icon", getServiceIcon);
serviceRouter.post(
  "/",
  createRateLimiter(10, 60_000, "POST /services"),
  createServiceDirect,
);
serviceRouter.post(
  "/install",
  createRateLimiter(10, 60_000, "POST /services/install"),
  installServiceRegistry,
);
serviceRouter.get(
  "/install/adapters",
  createRateLimiter(20, 60_000, "GET /services/install/adapters"),
  listInstallAdapters,
);
serviceRouter.post(
  "/:serviceId/update",
  createRateLimiter(10, 60_000, "POST /services/:serviceId/update"),
  updateService,
);
serviceRouter.post(
  "/:serviceId/sync",
  createRateLimiter(10, 60_000, "POST /services/:serviceId/sync"),
  syncService,
);
serviceRouter.patch(
  "/:serviceId",
  createRateLimiter(10, 60_000, "PATCH /services/:serviceId"),
  patchService,
);
serviceRouter.post("/:serviceId/enabled", setServiceEnabled);
serviceRouter.delete("/:serviceId", deleteService);

serviceRouter.get("/:serviceId/config/schema", getServiceConfigurationSchema);
serviceRouter.get("/:serviceId/config", getServiceConfiguration);
serviceRouter.patch("/:serviceId/config", patchServiceConfiguration);

serviceRouter.get("/:serviceId/secrets", getServiceSecrets);
serviceRouter.get("/:serviceId/secrets/schema", getServiceSecretsSchema);
serviceRouter.patch("/:serviceId/secrets", patchServiceSecrets);
