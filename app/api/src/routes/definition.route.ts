import express, { Router } from "express";

import {
  createDefinition,
  deleteDefinition,
  getDefinition,
  listDefinitions,
} from "@/controllers/definition.controller";

export const definitionRouter = Router();

definitionRouter.get("/", listDefinitions);
definitionRouter.get("/:definitionId", getDefinition);
definitionRouter.post(
  "/",
  express.raw({
    type: ["application/octet-stream", "text/plain"],
    limit: "10mb",
  }),
  createDefinition,
);
definitionRouter.delete("/:definitionId", deleteDefinition);
