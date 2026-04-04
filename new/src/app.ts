import cors from "cors";
import express from "express";
import pinoHttp from "pino-http";

import { logger } from "@/logger";
import { errorMiddleware } from "@/middleware/error.middleware";
import { healthRouter } from "@/routes/health.routes";
import { processRouter } from "@/routes/process.route";
import { EnvironmentPoolService } from "@/services/pool.service";
import { ProcessService } from "@/services/process.service";

export function createApp() {
  const app = express();

  const environmentPoolService = new EnvironmentPoolService();

  app.locals.environmentPoolService = environmentPoolService;
  app.locals.processService = new ProcessService(environmentPoolService);

  app.use(pinoHttp({ logger }));
  app.use(cors());
  app.use(express.json());
  app.use("/health", healthRouter);
  app.use("/processes", processRouter);
  app.use(errorMiddleware);

  return app;
}
