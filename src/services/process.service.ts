import {
  type Process,
  type ProcessQueryFilters,
  type ProcessStatus,
  type ProcessState,
  type StoredProcess,
} from "@/models/process";
import { HttpError } from "@/models/error";

export class ProcessService {
  private readonly processes = new Map<string, StoredProcess>();
  private nextId = 1;

  constructor() {
    this.seedData();
  }

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
    const paddedId = String(this.nextId).padStart(4, "0");
    this.nextId += 1;
    return `proc_demo_${paddedId}`;
  }

  private seedData(): void {
    const seeded: StoredProcess[] = [
      {
        process: {
          pid: "proc_01j9z8k2v4f3g5h7m0n1p6q",
          state: "idle",
          status: "success",
        },
        code: 'output({ id: 1, name: "Alice" });',
        output: {
          id: 1,
          name: "Alice",
          email: "alice@example.com",
        },
        stdout: "fetching user...\ndone\n",
        stderr: "",
      },
      {
        process: {
          pid: "proc_01j9z8k2v4f3g5h7m0n1p6r",
          state: "running",
          status: null,
        },
        code: "while (true) {}",
        output: null,
        stdout: "working...\n",
        stderr: "",
      },
      {
        process: {
          pid: "proc_01j9z8k2v4f3g5h7m0n1p6s",
          state: "queued",
          status: null,
        },
        code: 'console.log("hello");',
        output: null,
        stdout: "",
        stderr: "",
      },
    ];

    for (const item of seeded) {
      this.processes.set(item.process.pid, item);
    }
  }
}

export const processService = new ProcessService();
