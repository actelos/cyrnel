import {
  type Process,
  type ProcessState,
  type StoredProcess,
  type ProcessQueryFilters,
} from "@/models/process";
import { logger } from "@/logger";
import { HttpError } from "@/models/error";
import type { Pool, PooledInstance } from "@/services/pool.service";

export class ProcessService {
  private readonly processes = new Map<number, StoredProcess>();
  private readonly pidPool: number[] = [];
  private readonly running = new Map<number, PooledInstance>();
  private nextId = 1;

  constructor(private readonly pool: Pool) {}

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
      stdoutChunks: [],
      stderrChunks: [],
    });

    void this.executeProcess(pid);

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
    return stored.stdoutChunks.join("");
  }

  getStderr(pid: number): string {
    const stored = this.getStored(pid);
    this.assertIdle(stored.process.state);
    return stored.stderrChunks.join("");
  }

  kill(pid: number): Process {
    const stored = this.getStored(pid);

    if (stored.process.state === "idle") {
      throw new HttpError(409, "Process is already idle.");
    }

    if (stored.process.state === "terminating") {
      return stored.process;
    }

    const runningInstance = this.running.get(pid);

    if (runningInstance) {
      stored.process.state = "terminating";

      void runningInstance.module.kill().catch((err) => {
        logger.warn({ err, pid }, "Failed to send kill signal to module");
      });

      return stored.process;
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
      stored.stdoutChunks.length > 0 ||
      stored.stderrChunks.length > 0;

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
      stored.stdoutChunks = [];
      stored.stderrChunks = [];
    }

    void this.executeProcess(pid);

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

    const pid = this.nextId;
    this.nextId += 1;
    return pid;
  }

  private async executeProcess(pid: number): Promise<void> {
    let instance: PooledInstance | null = null;
    let onStdout: ((chunk: Buffer) => void) | null = null;
    let onStderr: ((chunk: Buffer) => void) | null = null;
    let onOutput: ((data: unknown) => void) | null = null;

    try {
      instance = await this.pool.acquire();

      const stored = this.processes.get(pid);
      if (!stored || stored.process.state !== "queued") {
        this.pool.release(instance);
        instance = null;
        return;
      }

      stored.process.state = "running";
      stored.process.status = null;
      this.running.set(pid, instance);

      onStdout = (chunk: Buffer) => {
        const current = this.processes.get(pid);
        if (!current) {
          return;
        }

        current.stdoutChunks.push(chunk.toString());
      };

      onStderr = (chunk: Buffer) => {
        const current = this.processes.get(pid);
        if (!current) {
          return;
        }

        current.stderrChunks.push(chunk.toString());
      };

      onOutput = (data: unknown) => {
        const current = this.processes.get(pid);
        if (!current) {
          return;
        }

        current.output = data;
      };

      instance.module.on("stdout", onStdout);
      instance.module.on("stderr", onStderr);
      instance.module.on("output", onOutput);

      const status = await instance.module.execute(stored.code);

      const current = this.processes.get(pid);
      if (current) {
        current.process.state = "idle";
        current.process.status = status;
      }
    } catch (err) {
      const current = this.processes.get(pid);

      if (current) {
        current.process.state = "idle";
        current.process.status = "failed";
      }

      logger.error({ err, pid }, "Process execution failed");
    } finally {
      if (instance) {
        if (onStdout) {
          instance.module.off("stdout", onStdout);
        }

        if (onStderr) {
          instance.module.off("stderr", onStderr);
        }

        if (onOutput) {
          instance.module.off("output", onOutput);
        }

        this.running.delete(pid);
        this.pool.release(instance);
      }
    }
  }
}
