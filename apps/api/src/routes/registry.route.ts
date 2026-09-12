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
import { ownerCredentialRouter } from "@/routes/credential.route";

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
registryRouter.delete(
  "/:id/auth",
  createRateLimiter(5, 60_000, "DELETE /registries/:id/auth"),
  deleteRegistryAuth,
);
registryRouter.get(
  "/:id/definitions",
  createRateLimiter(20, 60_000, "GET /registries/:id/definitions"),
  browseDefinitions,
);
registryRouter.get(
  "/:id/modules",
  createRateLimiter(20, 60_000, "GET /registries/:id/modules"),
  browseModules,
);
registryRouter.get(
  "/:id/definitions/:defId/icon",
  createRateLimiter(30, 60_000, "GET /registries/:id/definitions/:defId/icon"),
  getDefinitionIcon,
);
registryRouter.get(
  "/:id/modules/:modId/icon",
  createRateLimiter(30, 60_000, "GET /registries/:id/modules/:modId/icon"),
  getModuleIcon,
);
registryRouter.delete(
  "/:id",
  createRateLimiter(10, 60_000, "DELETE /registries/:id"),
  deleteRegistry,
);

registryRouter.use("/:id/credentials", ownerCredentialRouter("registry"));
