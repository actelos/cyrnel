import { Router } from "express";

import { invokeTool } from "@/controllers/invoke.controller";

export const invokeRouter = Router();

invokeRouter.post("/", invokeTool);