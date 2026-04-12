import cors from "cors";
import express from "express";
import pinoHttp from "pino-http";

import { logger } from "@/logger";
import { errorMiddleware } from "@/middleware/error.middleware";
import { definitionRouter } from "@/routes/definition.route";
import { processRouter } from "@/routes/process.route";
import { serviceRouter } from "@/routes/service.route";
import { DefinitionService } from "@/services/definition.service";
import { ManifestService } from "@/services/manifest.service";
import { EnvironmentPoolService } from "@/services/pool.service";
import { ProcessService } from "@/services/process.service";

export function createApp() {
  const app = express();

  const environmentPoolService = new EnvironmentPoolService();
  const manifestService = new ManifestService();
  const definitionService = new DefinitionService();

  app.locals.environmentPoolService = environmentPoolService;
  app.locals.manifestService = manifestService;
  app.locals.definitionService = definitionService;
  app.locals.processService = new ProcessService(environmentPoolService);

  app.use(pinoHttp({ logger }));
  app.use(cors());
  app.use(express.json());
  app.use("/definitions", definitionRouter);
  app.use("/processes", processRouter);
  app.use("/services", serviceRouter);
  app.use(errorMiddleware);

  return app;
}
