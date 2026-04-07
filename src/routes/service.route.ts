import { Router } from "express";

import { getService, listServices } from "@/controllers/service.controller";

export const serviceRouter = Router();

serviceRouter.get("/", listServices);
serviceRouter.get("/:serviceId", getService);
