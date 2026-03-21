import {
  type Process,
  type ProcessState,
  type StoredProcess,
  type ProcessQueryFilters,
} from "@/models/process";
import type { ExecutionStatus } from "@/config/modules";
import { StringDecoder } from "node:string_decoder";
import { logger } from "@/logger";
import { HttpError } from "@/models/error";
import type {
  EnvironmentPool,
  EnvironmentPoolInstance,
} from "@/services/pool.service";

const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000;

class ProcessExecutionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessExecutionTimeoutError";
  }
}

export class ProcessService {
  private readonly processes = new Map<number, StoredProcess>();
  private readonly pidPool: number[] = [];
  private readonly running = new Map<number, EnvironmentPoolInstance>();
  private nextId = 1;

  constructor(
    private readonly environmentPool: EnvironmentPool,
    private readonly options: {
      executeTimeoutMs?: number;
    } = {},
  ) {}

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

  create(code: string, environment: string, ref?: string): number {
    if (!this.environmentPool.supportsEnvironment(environment)) {
      throw new HttpError(400, `No environment modules match "${environment}"`);
    }

    const pid = this.createPid();

    this.processes.set(pid, {
      process: {
        pid,
        state: "queued",
        status: null,
        ...(ref !== undefined ? { ref } : {}),
      },
      environment,
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

    if (!this.environmentPool.supportsEnvironment(stored.environment)) {
      throw new HttpError(
        400,
        `No environment modules match "${stored.environment}"`,
      );
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
    let instance: EnvironmentPoolInstance | null = null;
    let onStdout: ((chunk: Buffer) => void) | null = null;
    let onStderr: ((chunk: Buffer) => void) | null = null;
    let onOutput: ((data: unknown) => void) | null = null;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    try {
      const queued = this.processes.get(pid);
      if (!queued || queued.process.state !== "queued") {
        return;
      }

      if (!this.environmentPool.supportsEnvironment(queued.environment)) {
        throw new HttpError(
          400,
          `No environment modules match "${queued.environment}"`,
        );
      }

      instance = await this.environmentPool.acquire(queued.environment);

      const stored = this.processes.get(pid);
      if (!stored || stored.process.state !== "queued") {
        this.environmentPool.release(instance);
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

        current.stdoutChunks.push(stdoutDecoder.write(chunk));
      };

      onStderr = (chunk: Buffer) => {
        const current = this.processes.get(pid);
        if (!current) {
          return;
        }

        current.stderrChunks.push(stderrDecoder.write(chunk));
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

      const timeoutMs =
        this.options.executeTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;

      const status = await this.executeWithTimeout(
        instance.module.execute(stored.code),
        timeoutMs,
      );

      const current = this.processes.get(pid);
      if (current) {
        const stdoutRemainder = stdoutDecoder.end();
        if (stdoutRemainder.length > 0) {
          current.stdoutChunks.push(stdoutRemainder);
        }

        const stderrRemainder = stderrDecoder.end();
        if (stderrRemainder.length > 0) {
          current.stderrChunks.push(stderrRemainder);
        }

        current.process.state = "idle";
        current.process.status = status;
      }
    } catch (err) {
      const current = this.processes.get(pid);

      if (current) {
        const wasTerminating = current.process.state === "terminating";
        current.process.state = "idle";
        current.process.status = wasTerminating
          ? "canceled"
          : err instanceof ProcessExecutionTimeoutError
            ? "timeout"
            : "failed";

        if (err instanceof ProcessExecutionTimeoutError) {
          logger.warn({ err, pid }, "Process execution timed out");
        } else if (!wasTerminating) {
          logger.error({ err, pid }, "Process execution failed");
        } else {
          logger.warn(
            { err, pid },
            "Module threw during kill; treating as canceled",
          );
        }
      } else {
        logger.error({ err, pid }, "Process execution failed");
      }
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
        this.environmentPool.release(instance);
      }
    }
  }

  private async executeWithTimeout(
    execution: Promise<ExecutionStatus>,
    timeoutMs: number,
  ): Promise<ExecutionStatus> {
    if (timeoutMs <= 0) {
      return execution;
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    try {
      return await Promise.race([
        execution,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(
              new ProcessExecutionTimeoutError(
                `Execution exceeded timeout of ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}
