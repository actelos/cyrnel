import cors from "cors";
import express from "express";
import pinoHttp from "pino-http";

import { logger } from "@/logger";
import { errorMiddleware } from "@/middleware/error.middleware";
import { healthRouter } from "@/routes/health.routes";

export function createApp() {
  const app = express();

  app.use(pinoHttp({ logger }));
  app.use(cors());
  app.use(express.json());
  app.use("/health", healthRouter);
  app.use(errorMiddleware);

  return app;
}
