import { Router } from "express";

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

export const processRouter = Router();

processRouter.get("/", listProcesses);
processRouter.post("/", createProcess);
processRouter.get("/:pid", getProcess);
processRouter.delete("/:pid", deleteProcess);

processRouter.get("/:pid/code", getProcessCode);
processRouter.get("/:pid/output", getProcessOutput);
processRouter.get("/:pid/stdout", getProcessStdout);
processRouter.get("/:pid/stderr", getProcessStderr);

processRouter.post("/:pid/signals/run", runProcess);
processRouter.post("/:pid/signals/kill", killProcess);
