import { type Router as ExpressRouter, Router } from "express";

import {
  addRegistry,
  browseDefinitions,
  browseModules,
  deleteRegistry,
  deleteRegistryAuth,
  getDefinitionIcon,
  getModuleIcon,
  getRegistryAuth,
  listRegistries,
  refreshRegistry,
  setRegistryAuth,
} from "@/controllers/registry.controller";
import { createRateLimiter } from "@/middleware/rate-limit.middleware";

export const registryRouter: ExpressRouter = Router();

registryRouter.post(
  "/",
  createRateLimiter(10, 60_000, "POST /registries"),
  addRegistry,
);
registryRouter.get("/", listRegistries);
registryRouter.post(
  "/:id/refresh",
  createRateLimiter(10, 60_000, "POST /registries/:id/refresh"),
  refreshRegistry,
);
registryRouter.post(
  "/:id/auth",
  createRateLimiter(5, 60_000, "POST /registries/:id/auth"),
  setRegistryAuth,
);
registryRouter.get("/:id/auth", getRegistryAuth);
registryRouter.delete("/:id/auth", deleteRegistryAuth);
registryRouter.get("/:id/definitions", browseDefinitions);
registryRouter.get("/:id/modules", browseModules);
registryRouter.get("/:id/definitions/:defId/icon", getDefinitionIcon);
registryRouter.get("/:id/modules/:modId/icon", getModuleIcon);
registryRouter.delete("/:id", deleteRegistry);
