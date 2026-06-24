import { EXECUTION_EXIT_STATES, EXECUTION_STATES } from "@cyrnel/sdk";

export const PROCESS_STATES = [
  ...EXECUTION_STATES,
  "idle",
  "terminating",
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
  options: {
    timeoutMs?: number | null;
  };
  autorun?: boolean;
  output: Record<string, unknown>;
  stdout: Buffer;
  stderr: Buffer;
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
>;

export interface FilterProcessInput {
  ref?: string;
  state?: ProcessState;
  exitState?: ProcessExitState;
}

export interface GetProcessResult {
  id: number;
  ref?: string;
  state: ProcessState;
  exitState: ProcessExitState;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export type ListProcessResult = GetProcessResult;
