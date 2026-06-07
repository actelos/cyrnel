import { type Router as ExpressRouter, Router } from "express";

import {
  deleteModule,
  getModule,
  getModuleConfiguration,
  getModuleConfigurationSchema,
  getModuleSecretsSchema,
  installModule,
  listModules,
  patchModuleConfiguration,
  patchModuleSecrets,
  reloadModules,
  setModuleEnabled,
  updateModule,
} from "@/controllers/module.controller";

export const moduleRouter: ExpressRouter = Router();

moduleRouter.get("/", listModules);
moduleRouter.get("/:moduleId", getModule);
moduleRouter.post("/reload", reloadModules);
moduleRouter.post("/install", installModule);
moduleRouter.post("/:moduleId/update", updateModule);
moduleRouter.post("/:moduleId/enabled", setModuleEnabled);
moduleRouter.delete("/:moduleId", deleteModule);

moduleRouter.get("/:moduleId/config/schema", getModuleConfigurationSchema);
moduleRouter.get("/:moduleId/config", getModuleConfiguration);
moduleRouter.patch("/:moduleId/config", patchModuleConfiguration);

moduleRouter.get("/:moduleId/secrets/schema", getModuleSecretsSchema);
moduleRouter.patch("/:moduleId/secrets", patchModuleSecrets);
