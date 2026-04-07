import { Router } from "express";

import { listTools } from "@/controllers/tool.controller";

export const toolRouter = Router();

toolRouter.get("/:toolName", listTools);
