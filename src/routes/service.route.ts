import { Router } from "express";

import {
	createService,
	deleteService,
	getService,
	listServices,
	updateService,
} from "@/controllers/service.controller";

export const serviceRouter = Router();

serviceRouter.get("/", listServices);
serviceRouter.get("/:serviceId", getService);
serviceRouter.post("/:serviceId", createService);
serviceRouter.put("/:serviceId", updateService);
serviceRouter.delete("/:serviceId", deleteService);
