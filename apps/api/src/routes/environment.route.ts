import { type Router as ExpressRouter, Router } from "express";

import { getEnvironmentDocs } from "@/controllers/environment.controller";

export const environmentRouter: ExpressRouter = Router();

environmentRouter.get("/docs", getEnvironmentDocs);
