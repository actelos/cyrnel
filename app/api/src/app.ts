import cors from "cors";
import express from "express";
import pinoHttp from "pino-http";

import { logger } from "@/logger";
import { apiKeyMiddleware } from "@/middleware/auth.middleware";
import { errorMiddleware } from "@/middleware/error.middleware";
import { logRouter } from "@/routes/log.route";
import { processRouter } from "@/routes/process.route";
import { serviceRouter } from "@/routes/service.route";
import { LogService } from "@/services/log.service";
import { ManifestService } from "@/services/manifest.service";
import { EnvironmentPoolService } from "@/services/pool.service";
import { ProcessService } from "@/services/process.service";

export function createApp() {
  const app = express();

  const environmentPoolService = new EnvironmentPoolService();
  const manifestService = new ManifestService();
  const logService = new LogService();

  app.locals.environmentPoolService = environmentPoolService;
  app.locals.manifestService = manifestService;
  app.locals.logService = logService;
  app.locals.processService = new ProcessService(environmentPoolService, {
    manifestService,
  });

  app.use(pinoHttp({ logger }));
  app.use(cors());
  app.use(express.json());
  app.use(apiKeyMiddleware);
  app.use("/processes", processRouter);
  app.use("/services", serviceRouter);
  app.use("/logs", logRouter);
  app.use(errorMiddleware);

  return app;
}
