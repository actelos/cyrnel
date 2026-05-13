import { Router } from "express";

import {
  discoverServices,
  discoverTools,
} from "@/controllers/discover.controller";

export const discoverRouter = Router();

discoverRouter.post("/tools", discoverTools);
discoverRouter.post("/services", discoverServices);
