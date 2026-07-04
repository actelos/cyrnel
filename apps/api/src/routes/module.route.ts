import { type Router as ExpressRouter, Router } from "express";

import {
  createModule,
  deleteModule,
  getModule,
  getModuleConfiguration,
  getModuleConfigurationSchema,
  getModuleSecrets,
  getModuleSecretsSchema,
  installModule,
  listModules,
  patchModule,
  patchModuleConfiguration,
  patchModuleSecrets,
  reloadModules,
  setModuleEnabled,
  updateModule,
} from "@/controllers/module.controller";
import { createRateLimiter } from "@/middleware/rate-limit.middleware";

export const moduleRouter: ExpressRouter = Router();

moduleRouter.get("/", listModules);
moduleRouter.get("/:moduleId", getModule);
moduleRouter.post("/", createModule);
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
moduleRouter.post("/:moduleId/enabled", setModuleEnabled);
moduleRouter.delete("/:moduleId", deleteModule);

moduleRouter.get("/:moduleId/config/schema", getModuleConfigurationSchema);
moduleRouter.get("/:moduleId/config", getModuleConfiguration);
moduleRouter.patch("/:moduleId/config", patchModuleConfiguration);

moduleRouter.get("/:moduleId/secrets", getModuleSecrets);
moduleRouter.get("/:moduleId/secrets/schema", getModuleSecretsSchema);
moduleRouter.patch("/:moduleId/secrets", patchModuleSecrets);
