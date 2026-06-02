import { z } from "zod";

// Common

export const Pid = z
  .number()
  .int()
  .min(1)
  .describe("Process id (positive integer). Example: 12.");

export const ServiceId = z
  .string()
  .min(1)
  .describe('Exact service identifier. Example: "github".');

export const ToolId = z
  .string()
  .min(1)
  .describe('Exact tool identifier within the service. Example: "listIssues".');

export const ModuleId = z
  .string()
  .min(1)
  .describe('Exact module identifier. Example: "openapi".');

// Enums

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

export const ModuleType = z.enum(["adapter", "environment"]);
export type ModuleType = z.infer<typeof ModuleType>;

// JSON schema

const path = z.string().min(1).describe("JSON Pointer path (non-empty).");
const value = z.unknown().describe("Value for the JSON Patch operation.");

const Add = z.object({
  op: z.literal("add"),
  path,
  value,
});

const Remove = z.object({
  op: z.literal("remove"),
  path,
});

const Replace = z.object({
  op: z.literal("replace"),
  path,
  value,
});

const Move = z.object({
  op: z.literal("move"),
  path,
  from: z.string().min(1).describe("Source JSON Pointer path."),
});

const Copy = z.object({
  op: z.literal("copy"),
  path,
  from: z.string().min(1).describe("Source JSON Pointer path."),
});

const Test = z.object({
  op: z.literal("test"),
  path,
  value,
});

export const JsonPatchOperation = z.discriminatedUnion("op", [
  Add,
  Remove,
  Replace,
  Move,
  Copy,
  Test,
]);
export type JsonPatchOperation = z.infer<typeof JsonPatchOperation>;

export const JsonPatch = z
  .array(JsonPatchOperation)
  .min(1)
  .describe(
    'JSON Patch operation list (RFC 6902 style). Example: [{"op":"add","path":"/enabled","value":true}].',
  );
export type JsonPatch = z.infer<typeof JsonPatch>;
