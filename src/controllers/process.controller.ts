import type { Request, Response } from "express";

import { HttpError } from "@/models/error";
import { processService } from "@/services/process-dummy.service";
import {
  PROCESS_STATES,
  PROCESS_STATUSES,
  type ProcessState,
  type ProcessStatus,
  type ProcessQueryFilters,
} from "@/models/process";

export function listProcesses(req: Request, res: Response): void {
  const state = parseState(req.query.state);
  const status = parseStatus(req.query.status);

  const filters: ProcessQueryFilters = {
    state,
    status,
  };

  const processes = processService.list(filters);
  res.status(200).json({ processes });
}

export function createProcess(req: Request, res: Response): void {
  if (
    !req.body ||
    typeof req.body !== "object" ||
    typeof req.body.code !== "string"
  ) {
    throw new HttpError(400, "Missing required field: code");
  }

  const pid = processService.create(req.body.code);
  res.status(201).json({ pid });
}

export function getProcess(req: Request, res: Response): void {
  const process = processService.get(req.params.pid);
  res.status(200).json(process);
}

export function getProcessOutput(req: Request, res: Response): void {
  const output = processService.getOutput(req.params.pid);
  res.status(200).json({ output });
}

export function getProcessStdout(req: Request, res: Response): void {
  const stdout = processService.getStdout(req.params.pid);
  res.status(200).type("text/plain").send(stdout);
}

export function getProcessStderr(req: Request, res: Response): void {
  const stderr = processService.getStderr(req.params.pid);
  res.status(200).type("text/plain").send(stderr);
}

export function killProcess(req: Request, res: Response): void {
  if (!req.body || typeof req.body !== "object") {
    throw new HttpError(400, "Request body must be an object.");
  }

  const process = processService.kill(req.params.pid);
  res.status(200).json(process);
}

export function runProcess(req: Request, res: Response): void {
  if (!req.body || typeof req.body !== "object") {
    throw new HttpError(400, "Request body must be an object.");
  }

  const force = parseForce(req.body.force);
  const process = processService.run(req.params.pid, force);

  res.status(200).json(process);
}

function parseState(raw: unknown): ProcessState | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (
    typeof raw !== "string" ||
    !PROCESS_STATES.includes(raw as ProcessState)
  ) {
    throw new HttpError(
      400,
      "Invalid value for 'state': must be one of queued, running, idle.",
    );
  }

  return raw as ProcessState;
}

function parseStatus(raw: unknown): ProcessStatus | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (raw === "null") {
    return null;
  }

  if (typeof raw !== "string") {
    throw new HttpError(
      400,
      "Invalid value for 'status': must be one of success, failed, canceled, null.",
    );
  }

  const allowed = PROCESS_STATUSES.filter(
    (item): item is Exclude<ProcessStatus, null> => item !== null,
  );

  if (!allowed.includes(raw as Exclude<ProcessStatus, null>)) {
    throw new HttpError(
      400,
      "Invalid value for 'status': must be one of success, failed, canceled, null.",
    );
  }

  return raw as Exclude<ProcessStatus, null>;
}

function parseForce(raw: unknown): boolean {
  if (raw === undefined) {
    return false;
  }

  if (typeof raw !== "boolean") {
    throw new HttpError(400, "Field 'force' must be a boolean.");
  }

  return raw;
}
