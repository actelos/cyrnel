import { type Router as ExpressRouter, Router } from "express";

import {
  createRegistry,
  deleteRegistry,
  listRegistries,
} from "@/controllers/registry.controller";

export const registryRouter: ExpressRouter = Router();

registryRouter.get("/", listRegistries);
registryRouter.post("/", createRegistry);
registryRouter.delete("/:id", deleteRegistry);
