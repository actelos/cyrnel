import { z } from "zod";

export const ProcessId = z
  .number()
  .int()
  .min(1)
  .describe("Stable process id (positive integer). Example: 42.");

export const ServiceId = z
  .string()
  .min(1)
  .describe('Exact service identifier. Example: "github".');

export const ToolId = z
  .string()
  .min(1)
  .describe('Exact tool identifier within the service. Example: "listIssues".');

export const ProcessState = z.enum([
  "idle",
  "queued",
  "running",
  "terminating",
]);
export type ProcessState = z.infer<typeof ProcessState>;

export const ProcessExitState = z.enum([
  "failed",
  "success",
  "timeout",
  "canceled",
]);
export type ProcessExitState = z.infer<typeof ProcessExitState>;

export const ProcessExitStateQuery = z.enum([
  "failed",
  "success",
  "timeout",
  "canceled",
  "null",
]);
export type ProcessExitStateQuery = z.infer<typeof ProcessExitStateQuery>;
