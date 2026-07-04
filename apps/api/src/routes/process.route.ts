import { type Router as ExpressRouter, Router } from "express";

import {
  createProcess,
  deleteProcess,
  getProcess,
  getProcessCode,
  getProcessOutput,
  getProcessStderr,
  getProcessStdout,
  killProcess,
  listProcesses,
  runProcess,
} from "@/controllers/process.controller";
import { createRateLimiter } from "@/middleware/rate-limit.middleware";

export const processRouter: ExpressRouter = Router();

processRouter.get("/", listProcesses);
processRouter.post(
  "/",
  createRateLimiter(20, 60_000, "POST /processes"),
  createProcess,
);
processRouter.get("/:id", getProcess);
processRouter.delete("/:id", deleteProcess);

processRouter.get("/:id/code", getProcessCode);
processRouter.get("/:id/output", getProcessOutput);
processRouter.get("/:id/stdout", getProcessStdout);
processRouter.get("/:id/stderr", getProcessStderr);

processRouter.post(
  "/:id/signals/run",
  createRateLimiter(20, 60_000, "POST /processes/:id/signals/run"),
  runProcess,
);
processRouter.post(
  "/:id/signals/kill",
  createRateLimiter(10, 60_000, "POST /processes/:id/signals/kill"),
  killProcess,
);
