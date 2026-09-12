import { type Router as ExpressRouter, Router } from "express";

import {
  createModule,
  deleteModule,
  getModule,
  getModuleConfiguration,
  getModuleConfigurationSchema,
  getModuleIcon,
  getModuleSecrets,
  getModuleSecretsSchema,
  installModule,
  listModules,
  patchModule,
  patchModuleConfiguration,
  patchModuleSecrets,
  reloadModules,
  restartModule,
  setModuleAuth,
  setModuleEnabled,
  updateModule,
} from "@/controllers/module.controller";
import { createRateLimiter } from "@/middleware/rate-limit.middleware";
import { ownerCredentialRouter } from "@/routes/credential.route";

export const moduleRouter: ExpressRouter = Router();

moduleRouter.get("/", listModules);
moduleRouter.get("/:moduleId", getModule);
moduleRouter.get("/:moduleId/icon", getModuleIcon);
moduleRouter.post(
  "/",
  createRateLimiter(10, 60_000, "POST /modules"),
  createModule,
);
moduleRouter.post(
  "/reload",
  createRateLimiter(2, 60_000, "POST /modules/reload"),
  reloadModules,
);
moduleRouter.post(
  "/install",
  createRateLimiter(5, 60_000, "POST /modules/install"),
  installModule,
);
moduleRouter.post(
  "/:moduleId/update",
  createRateLimiter(5, 60_000, "POST /modules/:moduleId/update"),
  updateModule,
);
moduleRouter.patch(
  "/:moduleId",
  createRateLimiter(5, 60_000, "PATCH /modules/:moduleId"),
  patchModule,
);
moduleRouter.post(
  "/:moduleId/enabled",
  createRateLimiter(10, 60_000, "POST /modules/:moduleId/enabled"),
  setModuleEnabled,
);
moduleRouter.delete(
  "/:moduleId",
  createRateLimiter(10, 60_000, "DELETE /modules/:moduleId"),
  deleteModule,
);

moduleRouter.post(
  "/:moduleId/restart",
  createRateLimiter(10, 60_000, "POST /modules/:moduleId/restart"),
  restartModule,
);

moduleRouter.post(
  "/:moduleId/auth",
  createRateLimiter(10, 60_000, "POST /modules/:moduleId/auth"),
  setModuleAuth,
);

moduleRouter.get("/:moduleId/config/schema", getModuleConfigurationSchema);
moduleRouter.get("/:moduleId/config", getModuleConfiguration);
moduleRouter.patch(
  "/:moduleId/config",
  createRateLimiter(10, 60_000, "PATCH /modules/:moduleId/config"),
  patchModuleConfiguration,
);

moduleRouter.get("/:moduleId/secrets", getModuleSecrets);
moduleRouter.get("/:moduleId/secrets/schema", getModuleSecretsSchema);
moduleRouter.patch(
  "/:moduleId/secrets",
  createRateLimiter(10, 60_000, "PATCH /modules/:moduleId/secrets"),
  patchModuleSecrets,
);

moduleRouter.use("/:moduleId/credentials", ownerCredentialRouter("module"));
