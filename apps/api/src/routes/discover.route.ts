import { type Router as ExpressRouter, Router } from "express";

import {
  discoverServices,
  discoverTools,
} from "@/controllers/discover.controller";

export const discoverRouter: ExpressRouter = Router();

discoverRouter.post("/tools", discoverTools);
discoverRouter.post("/services", discoverServices);
