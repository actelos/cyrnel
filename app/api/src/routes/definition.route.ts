import { Router } from "express";
import multer from "multer";

import {
  createDefinition,
  deleteDefinition,
  getDefinition,
  installDefinition,
  listDefinitions,
} from "@/controllers/definition.controller";

export const definitionRouter = Router();
const upload = multer({ storage: multer.memoryStorage() });

definitionRouter.get("/", listDefinitions);
definitionRouter.get("/:definitionId", getDefinition);
definitionRouter.post("/", upload.single("file"), createDefinition);
definitionRouter.post("/install", installDefinition);
definitionRouter.delete("/:definitionId", deleteDefinition);
