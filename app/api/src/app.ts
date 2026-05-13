import cors from "cors";
import express from "express";
import pinoHttp from "pino-http";

import { logger } from "@/logger";
import { apiKeyMiddleware } from "@/middleware/auth.middleware";
import { errorMiddleware } from "@/middleware/error.middleware";
import { discoverRouter } from "@/routes/discover.route";
import { processRouter } from "@/routes/process.route";
import { serviceRouter } from "@/routes/service.route";
import { AdapterPoolService } from "@/services/adapter-pool.service";
import { EnvironmentPoolService } from "@/services/environment-pool.service";
import { ManifestService } from "@/services/manifest.service";
import { ProcessService } from "@/services/process.service";

export function createApp() {
  const app = express();

  const adapterPoolService = new AdapterPoolService();
  const environmentPoolService = new EnvironmentPoolService();
  const manifestService = new ManifestService();

  app.locals.adapterPoolService = adapterPoolService;
  app.locals.environmentPoolService = environmentPoolService;
  app.locals.manifestService = manifestService;
  app.locals.processService = new ProcessService(environmentPoolService, {
    manifestService,
    adapterPoolService,
  });

  app.use(pinoHttp({ logger }));
  app.use(cors());
  app.use(express.json());
  app.use(apiKeyMiddleware);
  app.use("/discover", discoverRouter);
  app.use("/processes", processRouter);
  app.use("/services", serviceRouter);
  app.use(errorMiddleware);

  return app;
}
