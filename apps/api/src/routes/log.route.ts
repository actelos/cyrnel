import { type Router as ExpressRouter, Router } from "express";

import { listLogs } from "@/controllers/log.controller";

export const logRouter: ExpressRouter = Router();

logRouter.get("/", listLogs);
