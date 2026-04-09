import { Router } from "express";

import {
  createService,
  deleteService,
  getService,
  listServices,
} from "@/controllers/service.controller";

export const serviceRouter = Router();

serviceRouter.get("/", listServices);
serviceRouter.get("/:serviceName", getService);
serviceRouter.post("/:serviceName", createService);
serviceRouter.delete("/:serviceName", deleteService);
