import {
  type Process,
  type ProcessState,
  type StoredProcess,
  type ProcessQueryFilters,
} from "@/models/process";
import { HttpError } from "@/models/error";

export class ProcessService {
  private readonly processes = new Map<string, StoredProcess>();
  private nextId = 1;

  list(filters: ProcessQueryFilters): Process[] {
    const all = Array.from(this.processes.values(), ({ process }) => process);

    return all.filter((item) => {
      if (filters.state && item.state !== filters.state) {
        return false;
      }

      if (filters.status !== undefined && item.status !== filters.status) {
        return false;
      }

      return true;
    });
  }

  create(code: string): string {
    const pid = this.createPid();

    this.processes.set(pid, {
      process: {
        pid,
        state: "queued",
        status: null,
      },
      code,
      output: null,
      stdout: "",
      stderr: "",
    });

    return pid;
  }

  get(pid: string): Process {
    return this.getStored(pid).process;
  }

  getOutput(pid: string): unknown {
    const stored = this.getStored(pid);
    this.assertIdle(stored.process.state);
    return stored.output;
  }

  getStdout(pid: string): string {
    const stored = this.getStored(pid);
    this.assertIdle(stored.process.state);
    return stored.stdout;
  }

  getStderr(pid: string): string {
    const stored = this.getStored(pid);
    this.assertIdle(stored.process.state);
    return stored.stderr;
  }

  kill(pid: string): Process {
    const stored = this.getStored(pid);

    if (stored.process.state === "idle") {
      throw new HttpError(409, "Process is already idle.");
    }

    stored.process.state = "idle";
    stored.process.status = "canceled";

    return stored.process;
  }

  run(pid: string, force: boolean): Process {
    const stored = this.getStored(pid);

    if (stored.process.state !== "idle") {
      throw new HttpError(409, "Process must be idle to accept a run signal.");
    }

    const hasExistingOutputs =
      stored.process.status !== null ||
      stored.output !== null ||
      stored.stdout.length > 0 ||
      stored.stderr.length > 0;

    if (hasExistingOutputs && !force) {
      throw new HttpError(
        400,
        "Process has existing outputs. Set force: true to overwrite.",
      );
    }

    stored.process.state = "queued";
    stored.process.status = null;

    if (force) {
      stored.output = null;
      stored.stdout = "";
      stored.stderr = "";
    }

    return stored.process;
  }

  private getStored(pid: string): StoredProcess {
    const found = this.processes.get(pid);

    if (!found) {
      throw new HttpError(404, "Process not found.");
    }

    return found;
  }

  private assertIdle(state: ProcessState): void {
    if (state !== "idle") {
      throw new HttpError(409, "Process output is not yet available.");
    }
  }

  private createPid(): string {
    this.nextId += 1;
    return `${this.nextId}`;
  }
}

export const processService = new ProcessService();
