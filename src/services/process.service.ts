import {
  type Process,
  type ProcessState,
  type StoredProcess,
  type ProcessQueryFilters,
} from "@/models/process";
import { HttpError } from "@/models/error";

export class ProcessService {
  private readonly processes = new Map<number, StoredProcess>();
  private readonly pidPool: number[] = [];
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

      if (filters.ref !== undefined && item.ref !== filters.ref) {
        return false;
      }

      return true;
    });
  }

  create(code: string, ref?: string): number {
    const pid = this.createPid();

    this.processes.set(pid, {
      process: {
        pid,
        state: "queued",
        status: null,
        ...(ref !== undefined ? { ref } : {}),
      },
      code,
      output: null,
      stdout: "",
      stderr: "",
    });

    return pid;
  }

  get(pid: number): Process {
    return this.getStored(pid).process;
  }

  getOutput(pid: number): unknown {
    const stored = this.getStored(pid);
    this.assertIdle(stored.process.state);
    return stored.output;
  }

  getStdout(pid: number): string {
    const stored = this.getStored(pid);
    this.assertIdle(stored.process.state);
    return stored.stdout;
  }

  getStderr(pid: number): string {
    const stored = this.getStored(pid);
    this.assertIdle(stored.process.state);
    return stored.stderr;
  }

  kill(pid: number): Process {
    const stored = this.getStored(pid);

    if (stored.process.state === "idle") {
      throw new HttpError(409, "Process is already idle.");
    }

    stored.process.state = "idle";
    stored.process.status = "canceled";

    return stored.process;
  }

  run(pid: number, force: boolean): Process {
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

  delete(pid: number): Process {
    const stored = this.getStored(pid);

    if (stored.process.state !== "idle") {
      throw new HttpError(
        409,
        "Process must be idle before it can be deleted.",
      );
    }

    this.processes.delete(pid);
    this.pidPool.push(pid);

    return stored.process;
  }

  private getStored(pid: number): StoredProcess {
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

  private createPid(): number {
    const pooled = this.pidPool.shift();
    if (pooled !== undefined) {
      return pooled;
    }

    this.nextId += 1;
    return this.nextId;
  }
}

export const processService = new ProcessService();
