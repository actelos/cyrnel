import { type Router as ExpressRouter, Router } from "express";

import {
  getModule,
  getModuleConfiguration,
  getModuleConfigurationSchema,
  getModuleSecretsSchema,
  listModules,
  patchModuleConfiguration,
  patchModuleSecrets,
  reloadModules,
  setModuleEnabled,
} from "@/controllers/module.controller";

export const moduleRouter: ExpressRouter = Router();

moduleRouter.get("/", listModules);
moduleRouter.post("/reload", reloadModules);
moduleRouter.get("/:moduleId", getModule);
moduleRouter.post("/:moduleId/enabled", setModuleEnabled);

moduleRouter.get("/:moduleId/config/schema", getModuleConfigurationSchema);
moduleRouter.get("/:moduleId/config", getModuleConfiguration);
moduleRouter.patch("/:moduleId/config", patchModuleConfiguration);

moduleRouter.get("/:moduleId/secrets/schema", getModuleSecretsSchema);
moduleRouter.patch("/:moduleId/secrets", patchModuleSecrets);
