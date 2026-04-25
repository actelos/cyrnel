import type { Request, Response } from "express";
import { z } from "zod";
import {
  PROCESS_STATES,
  PROCESS_STATUSES,
  type ProcessQueryFilters,
  type ProcessState,
  type ProcessStatus,
} from "@/models/process.model";
import type { ProcessService } from "@/services/process.service";
import { parseOrHttpError } from "@/utils/validation.util";

const processBodySchema = z.record(z.string(), z.unknown());

const createProcessBodySchema = z
  .object({
    code: z
      .string({ error: 'Field "code" must be a string' })
      .or(z.undefined()),
    ref: z
      .string({ error: "Field 'ref' in body must be a string." })
      .transform((value) => value.trim())
      .refine((value) => value.length > 0, {
        error: "Field 'ref' must not be empty.",
      })
      .optional(),
    timeout: z
      .number({ error: "Field 'timeout' must be a positive integer or null." })
      .int({ error: "Field 'timeout' must be a positive integer or null." })
      .positive({
        error: "Field 'timeout' must be a positive integer or null.",
      })
      .nullable()
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.code === undefined) {
      context.addIssue({
        code: "custom",
        message: "Missing required field: code",
        path: ["code"],
      });
    }
  })
  .transform((value) => ({
    code: value.code as string,
    ref: value.ref,
    timeout: value.timeout,
  }));

const forceBodySchema = z.object({
  force: z.boolean({ error: "Field 'force' must be a boolean." }).optional(),
});

const stateSchema = z
  .string()
  .refine(
    (value): value is ProcessState =>
      PROCESS_STATES.includes(value as ProcessState),
    {
      error: `Invalid value for 'state': must be one of ${PROCESS_STATES.join(", ")}.`,
    },
  );

const statusSchema = z
  .string()
  .refine(
    (value) =>
      value === "null" ||
      PROCESS_STATUSES.filter(
        (item): item is Exclude<ProcessStatus, null> => item !== null,
      ).includes(value as Exclude<ProcessStatus, null>),
    {
      error:
        "Invalid value for 'status': must be one of success, failed, timeout, canceled, null.",
    },
  )
  .transform(
    (value): ProcessStatus =>
      value === "null" ? null : (value as Exclude<ProcessStatus, null>),
  );

const refSchemaBySource = {
  body: z
    .string({ error: "Field 'ref' in body must be a string." })
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, {
      error: "Field 'ref' must not be empty.",
    }),
  query: z
    .string({ error: "Field 'ref' in query must be a string." })
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, {
      error: "Field 'ref' must not be empty.",
    }),
} as const;

const pidSchema = z
  .string({ error: "Field 'pid' must be a string." })
  .transform((value) => Number.parseInt(value, 10))
  .refine((value) => Number.isInteger(value) && value > 0, {
    error: "Field 'pid' must be a positive integer.",
  });

export function listProcesses(req: Request, res: Response): void {
  const processService = getProcessService(req);
  const state = parseState(req.query.state);
  const status = parseStatus(req.query.status);
  const ref = parseRef(req.query.ref, "query");

  const filters: ProcessQueryFilters = {
    ref,
    state,
    status,
  };

  const processes = processService.list(filters);
  res.status(200).json({ processes });
}

export function createProcess(req: Request, res: Response): void {
  const processService = getProcessService(req);
  const body = parseOrHttpError(
    createProcessBodySchema,
    req.body,
    "Request body must be an object.",
  );
  const ref = parseRef(body.ref, "body");
  const timeout = parseTimeout(body.timeout);
  const pid = processService.create(body.code, ref, timeout);
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
  res.status(200).json(output);
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
  parseOrHttpError(
    processBodySchema,
    req.body,
    "Request body must be an object.",
  );

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
  const body = parseOrHttpError(
    forceBodySchema,
    req.body,
    "Request body must be an object.",
  );
  const force = parseForce(body.force);
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

  return parseOrHttpError(stateSchema, raw);
}

function parseStatus(raw: unknown): ProcessStatus | undefined {
  if (raw === undefined) {
    return undefined;
  }

  return parseOrHttpError(statusSchema, raw);
}

function parseForce(raw: unknown): boolean {
  if (raw === undefined) {
    return false;
  }

  return parseOrHttpError(
    z.boolean({ error: "Field 'force' must be a boolean." }),
    raw,
  );
}

function parseRef(raw: unknown, source: "body" | "query"): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  return parseOrHttpError(refSchemaBySource[source], raw);
}

function parseTimeout(raw: unknown): number | null | undefined {
  if (raw === undefined) {
    return undefined;
  }

  return parseOrHttpError(
    z
      .number({ error: "Field 'timeout' must be a positive integer or null." })
      .int({ error: "Field 'timeout' must be a positive integer or null." })
      .positive({
        error: "Field 'timeout' must be a positive integer or null.",
      })
      .nullable(),
    raw,
  );
}

function parsePid(raw: unknown): number {
  return parseOrHttpError(pidSchema, raw);
}
