import { type Router as ExpressRouter, Router } from "express";

import {
  getModule,
  listModules,
  reloadModules,
  setModuleEnabled,
} from "@/controllers/module.controller";

export const moduleRouter: ExpressRouter = Router();

moduleRouter.get("/", listModules);
moduleRouter.post("/reload", reloadModules);
moduleRouter.get("/:moduleId", getModule);
moduleRouter.post("/:moduleId/enabled", setModuleEnabled);
