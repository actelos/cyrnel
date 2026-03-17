import { Router } from "express";

import {
  runProcess,
  getProcess,
  killProcess,
  createProcess,
  listProcesses,
  getProcessOutput,
  getProcessStderr,
  getProcessStdout,
} from "@/controllers/process.controller";

export const processRouter = Router();

processRouter.get("/", listProcesses);
processRouter.post("/", createProcess);
processRouter.get("/:pid", getProcess);

processRouter.get("/:pid/output", getProcessOutput);
processRouter.get("/:pid/stdout", getProcessStdout);
processRouter.get("/:pid/stderr", getProcessStderr);

processRouter.post("/:pid/signals/run", runProcess);
processRouter.post("/:pid/signals/kill", killProcess);
