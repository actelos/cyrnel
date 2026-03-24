import cors from "cors";
import express from "express";
import pinoHttp from "pino-http";

import { logger } from "@/logger";
import { invokeRouter } from "@/routes/invoke.routes";
import { processRouter } from "@/routes/process.routes";
import { errorMiddleware } from "@/middleware/error.middleware";

export function createApp() {
  const app = express();

  app.use(pinoHttp({ logger }));
  app.use(cors());
  app.use(express.json());
  app.use("/invoke", invokeRouter);
  app.use("/processes", processRouter);
  app.use(errorMiddleware);

  return app;
}
