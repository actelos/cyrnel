import cors from "cors";
import express from "express";

import { processRouter } from "@/routes/process.routes";
import { errorMiddleware } from "@/middleware/error.middleware";

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use("/processes", processRouter);
  app.use(errorMiddleware);

  return app;
}
