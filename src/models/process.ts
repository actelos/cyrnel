export const PROCESS_STATES = ["queued", "running", "idle"] as const;
export type ProcessState = (typeof PROCESS_STATES)[number];

export const PROCESS_STATUSES = [
  "success",
  "failed",
  "canceled",
  null,
] as const;
export type ProcessStatus = (typeof PROCESS_STATUSES)[number];

export interface Process {
  pid: number;
  state: ProcessState;
  status: ProcessStatus;
  ref?: string;
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

export interface ProcessOutputResponse {
  output: unknown;
}

export interface RunSignalRequest {
  force?: boolean;
}

export interface ProcessQueryFilters {
  state?: ProcessState;
  status?: ProcessStatus;
  ref?: string;
}

export interface StoredProcess {
  process: Process;
  code: string;
  output: unknown;
  stdout: string;
  stderr: string;
}
