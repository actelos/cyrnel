import { EXECUTION_EXIT_STATES, EXECUTION_STATES } from "@cyrnel/sdk";

export const PROCESS_STATES = [
  ...EXECUTION_STATES,
  "idle",
  "terminating",
  "terminated",
] as const;

export type ProcessState = (typeof PROCESS_STATES)[number];

export const PROCESS_EXIT_STATES = [...EXECUTION_EXIT_STATES, null] as const;

export type ProcessExitState = (typeof PROCESS_EXIT_STATES)[number];

export interface ProcessRecord {
  dbId: number;
  pid: number;
  ref?: string;
  state: ProcessState;
  exitState: ProcessExitState;
  error: string | null;
  code: string;
  timeoutMs: number | null;
  envConfig: Record<string, unknown>;
  autorun?: boolean;
  output: Record<string, unknown>;
  stdout: Buffer;
  stderr: Buffer;
  lastExecutedAt: number;
  createdAt: string;
}

export type CreateProcessInput = Omit<
  ProcessRecord,
  | "dbId"
  | "pid"
  | "state"
  | "exitState"
  | "error"
  | "output"
  | "stdout"
  | "stderr"
  | "timeoutMs"
  | "envConfig"
  | "lastExecutedAt"
  | "createdAt"
> & {
  timeoutMs?: number | null;
  envConfig?: Record<string, unknown>;
};

export interface FilterProcessInput {
  ref?: string;
  state?: ProcessState;
  exitState?: ProcessExitState;
  limit?: number;
  cursor?: string;
}

export interface GetProcessResult {
  id: number;
  pid: number | null;
  ref?: string;
  state: ProcessState;
  exitState: ProcessExitState;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  pendingApprovalIds?: string[];
}

export type SuspendedProcessResult = GetProcessResult & {
  state: "suspended";
  pendingApprovalIds: string[];
};

export type ListProcessResult = GetProcessResult;
