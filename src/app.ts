import cors from "cors";
import express from "express";
import pinoHttp from "pino-http";

import { logger } from "@/logger";
import { errorMiddleware } from "@/middleware/error.middleware";
import { healthRouter } from "@/routes/health.routes";
import { processRouter } from "@/routes/process.route";
import { serviceRouter } from "@/routes/service.route";
import { toolRouter } from "@/routes/tool.route";
import { ManifestService } from "@/services/manifest.service";
import { EnvironmentPoolService } from "@/services/pool.service";
import { ProcessService } from "@/services/process.service";

export function createApp() {
  const app = express();

  const environmentPoolService = new EnvironmentPoolService();
  const manifestService = new ManifestService();

  app.locals.environmentPoolService = environmentPoolService;
  app.locals.manifestService = manifestService;
  app.locals.processService = new ProcessService(environmentPoolService);

  app.use(pinoHttp({ logger }));
  app.use(cors());
  app.use(express.json());
  app.use("/health", healthRouter);
  app.use("/processes", processRouter);
  app.use("/services", serviceRouter);
  app.use("/tools", toolRouter);
  app.use(errorMiddleware);

  return app;
}
