import { Router } from "express";

import { deleteLogs, listLogs } from "@/controllers/log.controller";

export const logRouter = Router();

logRouter.get("/", listLogs);
logRouter.delete("/", deleteLogs);
