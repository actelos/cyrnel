import type { Request, Response } from "express";
import { z } from "zod";
import {
  type FilterProcessInput,
  PROCESS_EXIT_STATES,
  PROCESS_STATES,
  type ProcessExitState,
  type ProcessState,
} from "@/models/process.model";
import type { ProcessService } from "@/services/process.service";
import { parseOrHttpError } from "@/utils/validation.util";

const createProcessBodySchema = z
  .object({
    code: z
      .string({ error: 'Field "code" must be a string' })
      .max(100 * 1024, {
        error: "Field 'code' must not exceed 100 KB.",
      })
      .or(z.undefined()),
    ref: z
      .string({ error: "Field 'ref' in body must be a string." })
      .transform((v) => v.trim())
      .refine((v) => v.length > 0, { error: "Field 'ref' must not be empty." })
      .optional(),
    timeoutMs: z
      .number({
        error: "Field 'timeoutMs' must be a positive integer or null.",
      })
      .int({ error: "Field 'timeoutMs' must be a positive integer or null." })
      .positive({
        error: "Field 'timeoutMs' must be a positive integer or null.",
      })
      .nullable()
      .optional(),
    envConfig: z
      .record(z.string(), z.unknown(), {
        error: "Field 'envConfig' must be an object.",
      })
      .optional(),
    autorun: z
      .boolean({ error: "Field 'autorun' must be a boolean." })
      .optional()
      .default(true),
  })
  .superRefine((value, ctx) => {
    if (value.code === undefined)
      ctx.addIssue({
        code: "custom",
        message: "Missing required field: code",
        path: ["code"],
      });
  })
  .transform((value) => ({
    code: value.code as string,
    ref: value.ref,
    timeoutMs: value.timeoutMs ?? null,
    envConfig: value.envConfig ?? {},
    autorun: value.autorun,
  }));

const forceBodySchema = z.object({
  force: z.boolean({ error: "Field 'force' must be a boolean." }).optional(),
});

const stateSchema = z
  .string()
  .refine(
    (v): v is ProcessState => PROCESS_STATES.includes(v as ProcessState),
    {
      error: `Invalid value for 'state': must be one of ${PROCESS_STATES.join(", ")}.`,
    },
  );

const statusSchema = z
  .string()
  .refine(
    (v) =>
      v === "null" ||
      PROCESS_EXIT_STATES.filter(
        (s): s is Exclude<ProcessExitState, null> => s !== null,
      ).includes(v as Exclude<ProcessExitState, null>),
    {
      error:
        "Invalid value for 'status': must be one of success, failed, timeout, canceled, null.",
    },
  )
  .transform(
    (v): ProcessExitState =>
      v === "null" ? null : (v as Exclude<ProcessExitState, null>),
  );

const refSchema = (source: "body" | "query") =>
  z
    .string({ error: `Field 'ref' in ${source} must be a string.` })
    .transform((v) => v.trim())
    .refine((v) => v.length > 0, { error: "Field 'ref' must not be empty." });

function parseOptional<T>(schema: z.ZodType<T>, raw: unknown): T | undefined {
  return raw === undefined ? undefined : parseOrHttpError(schema, raw);
}

function getProcessService(req: Request): ProcessService {
  const service = req.app.locals.processService as ProcessService | undefined;
  if (!service) throw new Error("ProcessService not configured in app.locals");
  return service;
}

function parseId(req: Request): number {
  return parseOrHttpError(
    z
      .string({ error: "Field 'id' must be a string." })
      .transform((v) => Number.parseInt(v, 10))
      .refine((v) => Number.isInteger(v) && v > 0, {
        error: "Field 'id' must be a positive integer.",
      }),
    req.params.id,
  );
}

export async function listProcesses(
  req: Request,
  res: Response,
): Promise<void> {
  const filters: FilterProcessInput = {
    ref: parseOptional(refSchema("query"), req.query.ref),
    state: parseOptional(stateSchema, req.query.state),
    exitState: parseOptional(statusSchema, req.query.status),
  };
  res
    .status(200)
    .json({ processes: await getProcessService(req).list(filters) });
}

export async function createProcess(
  req: Request,
  res: Response,
): Promise<void> {
  const processService = getProcessService(req);
  const body = parseOrHttpError(
    createProcessBodySchema,
    req.body,
    "Request body must be an object.",
  );
  const { id } = await processService.create({
    ref: parseOptional(refSchema("body"), body.ref),
    code: body.code,
    timeoutMs: body.timeoutMs,
    envConfig: body.envConfig,
    autorun: body.autorun,
  });
  res.status(201).json({ id });
}

export async function getProcess(req: Request, res: Response): Promise<void> {
  res.status(200).json(await getProcessService(req).get(parseId(req)));
}

export async function getProcessOutput(
  req: Request,
  res: Response,
): Promise<void> {
  res.status(200).json(await getProcessService(req).getOutput(parseId(req)));
}

export async function getProcessCode(
  req: Request,
  res: Response,
): Promise<void> {
  res
    .status(200)
    .type("text/plain")
    .send(await getProcessService(req).getCode(parseId(req)));
}

export async function getProcessStdout(
  req: Request,
  res: Response,
): Promise<void> {
  res
    .status(200)
    .type("text/plain")
    .send(await getProcessService(req).getStdout(parseId(req)));
}

export async function getProcessStderr(
  req: Request,
  res: Response,
): Promise<void> {
  res
    .status(200)
    .type("text/plain")
    .send(await getProcessService(req).getStderr(parseId(req)));
}

export async function killProcess(req: Request, res: Response): Promise<void> {
  res.status(200).json(await getProcessService(req).kill(parseId(req)));
}

export async function deleteProcess(
  req: Request,
  res: Response,
): Promise<void> {
  res.status(200).json(await getProcessService(req).delete(parseId(req)));
}

export async function runProcess(req: Request, res: Response): Promise<void> {
  const processService = getProcessService(req);
  const body = parseOrHttpError(
    forceBodySchema,
    req.body,
    "Request body must be an object.",
  );
  const id = parseId(req);
  res.status(200).json(await processService.run(id, body.force ?? false));
}
