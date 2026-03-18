import {
  type Process,
  type ProcessState,
  type ProcessStatus,
  type StoredProcess,
  type ProcessQueryFilters,
} from "@/models/process";
import { HttpError } from "@/models/error";

interface ExecutionControl {
  generation: number;
  queueTimer?: ReturnType<typeof setTimeout>;
  runTimer?: ReturnType<typeof setTimeout>;
}

export class ProcessService {
  private readonly processes = new Map<number, StoredProcess>();
  private readonly execution = new Map<number, ExecutionControl>();
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

    this.startExecution(pid);

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

    this.clearExecution(pid);

    stored.process.state = "idle";
    stored.process.status = "canceled";

    return stored.process;
  }

  run(pid: number, force: boolean): Process {
    const stored = this.getStored(pid);

    if (stored.process.state !== "idle") {
      throw new HttpError(409, "Process must be idle to accept a run signal.");
    }

    this.clearExecution(pid);
    stored.process.state = "queued";
    stored.process.status = null;
    stored.output = null;
    stored.stdout = "";
    stored.stderr = "";

    this.startExecution(pid);

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

  private startExecution(pid: number): void {
    const stored = this.getStored(pid);
    const previous = this.execution.get(pid);

    if (previous?.queueTimer) {
      clearTimeout(previous.queueTimer);
    }

    if (previous?.runTimer) {
      clearTimeout(previous.runTimer);
    }

    const generation = (previous?.generation ?? 0) + 1;
    const control: ExecutionControl = { generation };
    this.execution.set(pid, control);

    const queueDelayMs = this.randomInt(150, 600);

    control.queueTimer = setTimeout(() => {
      const current = this.execution.get(pid);
      const latest = this.processes.get(pid);

      if (!current || current.generation !== generation || !latest) {
        return;
      }

      if (latest.process.state !== "queued") {
        return;
      }

      latest.process.state = "running";
      latest.process.status = null;
      latest.stdout = `Executing process ${pid}...\n`;
      latest.stderr = "";
      latest.output = {
        stage: "running",
        pid,
        startedAt: new Date().toISOString(),
      };

      const runDelayMs = this.randomInt(900, 2600);

      current.runTimer = setTimeout(() => {
        const now = this.execution.get(pid);
        const finalStored = this.processes.get(pid);

        if (!now || now.generation !== generation || !finalStored) {
          return;
        }

        if (finalStored.process.state !== "running") {
          return;
        }

        const status = this.randomFinalStatus();
        finalStored.process.state = "idle";
        finalStored.process.status = status;

        finalStored.stdout += `Process ${pid} completed with status: ${status}.\n`;

        if (status === "failed") {
          finalStored.stderr += "Execution failed in dummy runtime.\n";
        }

        finalStored.output = {
          stage: "complete",
          pid,
          status,
          finishedAt: new Date().toISOString(),
        };

        this.clearExecution(pid);
      }, runDelayMs);
    }, queueDelayMs);
  }

  private clearExecution(pid: number): void {
    const control = this.execution.get(pid);

    if (!control) {
      return;
    }

    if (control.queueTimer) {
      clearTimeout(control.queueTimer);
    }

    if (control.runTimer) {
      clearTimeout(control.runTimer);
    }

    this.execution.delete(pid);
  }

  private randomFinalStatus(): Exclude<ProcessStatus, "canceled" | null> {
    return Math.random() < 0.75 ? "success" : "failed";
  }

  private randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private createPid(): number {
    const pid = this.nextId;
    this.nextId += 1;
    return pid;
  }
}

export const processService = new ProcessService();
