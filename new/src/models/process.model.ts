export const PROCESS_STATES = [
  "idle",
  "queued",
  "running",
  "terminating",
] as const;

export type ProcessState = (typeof PROCESS_STATES)[number];

export const PROCESS_STATUSES = [
  null,
  "failed",
  "success",
  "timeout",
  "canceled",
] as const;

export type ProcessStatus = (typeof PROCESS_STATUSES)[number];

export interface Process {
  pid: number;
  ref?: string;
  state: ProcessState;
  status: ProcessStatus;
}

export interface ProcessList {
  processes: Process[];
}

export interface CreateProcessRequest {
  code: string;
  ref?: string;
}

export interface ProcessCreatedResponse {
  pid: number;
}

export type ProcessOutput = Record<string, unknown>;

export type ProcessOutputResponse = ProcessOutput;

export interface RunSignalRequest {
  force?: boolean;
}

export interface ProcessQueryFilters {
  ref?: string;
  state?: ProcessState;
  status?: ProcessStatus;
}

export interface StoredProcess {
  process: Process;
  code: string;
  output: ProcessOutput;
  stdoutChunks: string[];
  stderrChunks: string[];
}
