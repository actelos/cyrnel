import { EXECUTION_EXIT_STATES, EXECUTION_STATES } from "@mci/sdk";

export const PROCESS_STATES = [
  ...EXECUTION_STATES,
  "idle",
  "terminating",
] as const;

export type ProcessState = (typeof PROCESS_STATES)[number];

export const PROCESS_EXIT_STATES = [...EXECUTION_EXIT_STATES, null] as const;

export type ProcessExitState = (typeof PROCESS_EXIT_STATES)[number];

export interface ProcessRecord {
  pid: number;
  ref?: string;
  state: ProcessState;
  exitState: ProcessExitState;
  error: string | null;
  code: string;
  options: {
    timeoutMs?: number | null;
  };
  output: Record<string, unknown>;
  stdout: Buffer;
  stderr: Buffer;
}

export type CreateProcessInput = Omit<
  ProcessRecord,
  "pid" | "state" | "exitState" | "error" | "output" | "stdout" | "stderr"
>;

export interface FilterProcessInput {
  ref?: string;
  state?: ProcessState;
  exitState?: ProcessExitState;
}

export type ListProcessResult = Omit<
  ProcessRecord,
  "code" | "options" | "output" | "stdout" | "stderr"
>;

export type GetProcessResult = ListProcessResult;
