import { type Router as ExpressRouter, Router } from "express";

import {
  addRegistry,
  browseDefinitions,
  browseModules,
  deleteRegistry,
  getDefinitionIcon,
  getModuleIcon,
  listRegistries,
  refreshRegistry,
} from "@/controllers/registry.controller";

export const registryRouter: ExpressRouter = Router();

registryRouter.get("/", listRegistries);
registryRouter.post("/", addRegistry);
registryRouter.post("/:id/refresh", refreshRegistry);
registryRouter.get("/:id/definitions", browseDefinitions);
registryRouter.get("/:id/modules", browseModules);
registryRouter.get("/:id/definitions/:defId/icon", getDefinitionIcon);
registryRouter.get("/:id/modules/:modId/icon", getModuleIcon);
registryRouter.delete("/:id", deleteRegistry);
