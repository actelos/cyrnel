import { z } from "zod";

export const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_TYPES = ["app", "request", "module"] as const;

export type LogType = (typeof LOG_TYPES)[number];

export const logEntrySchema = z.object({
  timestamp: z.number().int(),
  seq: z.number().int(),
  level: z.enum(LOG_LEVELS),
  type: z.enum(LOG_TYPES),
  message: z.string(),
  event: z.string().optional(),
  requestId: z.string().optional(),
  processId: z.union([z.number(), z.string()]).optional(),
  adapterId: z.string().optional(),
  serviceId: z.string().optional(),
  moduleId: z.string().optional(),
  moduleType: z.enum(["adapter", "environment"]).optional(),
  environmentId: z.string().optional(),
  executionId: z.number().int().optional(),
  dispatchId: z.string().optional(),
  toolId: z.string().optional(),
  pid: z.number().int(),
  phase: z.string().optional(),
  method: z.string().optional(),
  path: z.string().optional(),
  statusCode: z.number().int().optional(),
  durationMs: z.number().optional(),
  req: z.record(z.string(), z.unknown()).optional(),
  res: z.record(z.string(), z.unknown()).optional(),
  error: z.unknown().optional(),
  suppressedCount: z.number().int().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type LogEntry = z.infer<typeof logEntrySchema>;
