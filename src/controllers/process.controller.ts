import type { Request, Response } from "express";

import { HttpError } from "@/models/error";
import {
  PROCESS_STATES,
  PROCESS_STATUSES,
  type ProcessState,
  type ProcessStatus,
  type ProcessQueryFilters,
} from "@/models/process";
import type { ProcessService } from "@/services/process.service";

export function listProcesses(req: Request, res: Response): void {
  const processService = getProcessService(req);
  const state = parseState(req.query.state);
  const status = parseStatus(req.query.status);
  const ref = parseRef(req.query.ref, "query");

  const filters: ProcessQueryFilters = {
    state,
    status,
    ref,
  };

  const processes = processService.list(filters);
  res.status(200).json({ processes });
}

export function createProcess(req: Request, res: Response): void {
  const processService = getProcessService(req);
  if (
    !req.body ||
    typeof req.body !== "object" ||
    typeof req.body.code !== "string"
  ) {
    throw new HttpError(400, "Missing required field: code");
  }

  const ref = parseRef((req.body as { ref?: unknown }).ref, "body");
  const pid = processService.create(req.body.code, ref);
  res.status(201).json({ pid });
}

export function getProcess(req: Request, res: Response): void {
  const processService = getProcessService(req);
  const pid = parsePid(req.params.pid);
  const process = processService.get(pid);
  res.status(200).json(process);
}

export function getProcessOutput(req: Request, res: Response): void {
  const processService = getProcessService(req);
  const pid = parsePid(req.params.pid);
  const output = processService.getOutput(pid);
  res.status(200).json({ output });
}

export function getProcessStdout(req: Request, res: Response): void {
  const processService = getProcessService(req);
  const pid = parsePid(req.params.pid);
  const stdout = processService.getStdout(pid);
  res.status(200).type("text/plain").send(stdout);
}

export function getProcessStderr(req: Request, res: Response): void {
  const processService = getProcessService(req);
  const pid = parsePid(req.params.pid);
  const stderr = processService.getStderr(pid);
  res.status(200).type("text/plain").send(stderr);
}

export function killProcess(req: Request, res: Response): void {
  const processService = getProcessService(req);
  if (!req.body || typeof req.body !== "object") {
    throw new HttpError(400, "Request body must be an object.");
  }

  const pid = parsePid(req.params.pid);
  const process = processService.kill(pid);
  res.status(200).json(process);
}

export function deleteProcess(req: Request, res: Response): void {
  const processService = getProcessService(req);
  const pid = parsePid(req.params.pid);
  const process = processService.delete(pid);
  res.status(200).json(process);
}

export function runProcess(req: Request, res: Response): void {
  const processService = getProcessService(req);
  if (!req.body || typeof req.body !== "object") {
    throw new HttpError(400, "Request body must be an object.");
  }

  const force = parseForce(req.body.force);
  const pid = parsePid(req.params.pid);
  const process = processService.run(pid, force);

  res.status(200).json(process);
}

function getProcessService(req: Request): ProcessService {
  const service = req.app.locals.processService as ProcessService | undefined;

  if (!service) {
    throw new Error("ProcessService not configured in app.locals");
  }

  return service;
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

  const allowedLabels = PROCESS_STATUSES.map((item) =>
    item === null ? "null" : item,
  );
  const message = `Invalid value for 'status': must be one of ${allowedLabels.join(", ")}.`;

  if (raw === "null") {
    return null;
  }

  if (typeof raw !== "string") {
    throw new HttpError(400, message);
  }

  const allowed = PROCESS_STATUSES.filter(
    (item): item is Exclude<ProcessStatus, null> => item !== null,
  );

  if (!allowed.includes(raw as Exclude<ProcessStatus, null>)) {
    throw new HttpError(400, message);
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

function parseRef(raw: unknown, source: "body" | "query"): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw !== "string") {
    throw new HttpError(400, `Field 'ref' in ${source} must be a string.`);
  }

  const normalized = raw.trim();

  if (normalized.length === 0) {
    throw new HttpError(400, "Field 'ref' must not be empty.");
  }

  return normalized;
}

function parsePid(raw: unknown): number {
  if (typeof raw !== "string") {
    throw new HttpError(400, "Field 'pid' must be a string.");
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, "Field 'pid' must be a positive integer.");
  }

  return parsed;
}
