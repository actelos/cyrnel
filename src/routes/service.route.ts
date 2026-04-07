import { Router } from "express";

import {
	deleteService,
	getService,
	listServices,
} from "@/controllers/service.controller";

export const serviceRouter = Router();

serviceRouter.get("/", listServices);
serviceRouter.get("/:serviceId", getService);
serviceRouter.delete("/:serviceId", deleteService);
