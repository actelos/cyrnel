import { StringDecoder } from "node:string_decoder";

import type {
  ExecutionExitState,
  ExecutionInput,
  ExecutionState,
} from "@cyrnel/sdk";

import { logger } from "@/logger";
import { HttpError } from "@/models/error.model";
import type {
  CreateProcessInput,
  FilterProcessInput,
  GetProcessResult,
  ProcessRecord,
  ProcessState,
} from "@/models/process.model";

const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000;

interface ExecutionContext {
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  promise: Promise<void>;
}

interface EnvironmentController {
  execute(input: ExecutionInput): Promise<ExecutionExitState>;
  kill(eid: number): Promise<void>;
}

interface RunExecutionInput {
  process: {
    pid: number;
    code: string;
    options: {
      timeoutMs: number;
    };
  };
  context: ExecutionContext;
}

export class ProcessService {
  private readonly executions = new Map<number, ExecutionContext>();
  private readonly processes = new Map<number, ProcessRecord>();
  private readonly pidPool: number[] = [];
  private isShuttingDown = false;
  private nextId = 1;

  constructor(private readonly controller: EnvironmentController) {}

  list(filters: FilterProcessInput): GetProcessResult[] {
    return Array.from(this.processes.values())
      .filter(
        (process) =>
          (!filters.state || process.state === filters.state) &&
          (filters.exitState === undefined ||
            process.exitState === filters.exitState) &&
          (filters.ref === undefined || process.ref === filters.ref),
      )
      .map((p) => this.project(p));
  }

  create(input: CreateProcessInput): number {
    if (this.isShuttingDown) {
      throw new HttpError(503, "Service is shutting down.");
    }

    const pid = this.createPid();
    const autorun = input.autorun ?? true;

    this.processes.set(pid, {
      ...input,
      pid,
      autorun,
      state: autorun ? "queued" : "idle",
      exitState: null,
      error: null,
      output: {},
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });

    if (autorun) {
      this.startExecution(pid);
    }

    return pid;
  }

  get(pid: number): GetProcessResult {
    return this.project(this.getStored(pid));
  }

  getOutput(pid: number): Record<string, unknown> {
    const stored = this.getStored(pid);
    this.assertIdle(stored.state);
    return stored.output;
  }

  getCode(pid: number): string {
    const stored = this.getStored(pid);
    return stored.code;
  }

  getStdout(pid: number): string {
    const stored = this.getStored(pid);
    this.assertIdle(stored.state);
    return stored.stdout.toString("utf8");
  }

  getStderr(pid: number): string {
    const stored = this.getStored(pid);
    this.assertIdle(stored.state);
    return stored.stderr.toString("utf8");
  }

  kill(pid: number): GetProcessResult {
    const stored = this.getStored(pid);

    if (stored.state === "idle")
      throw new HttpError(409, "Process is already idle.");
    if (stored.state === "terminating") return this.project(stored);

    stored.state = "terminating";

    this.controller.kill(pid).catch((err) => {
      logger.warn({ err, pid }, "Failed to send kill signal");
    });

    return this.project(stored);
  }

  run(pid: number, force: boolean): GetProcessResult {
    if (this.isShuttingDown)
      throw new HttpError(503, "Service is shutting down.");

    const stored = this.getStored(pid);

    if (stored.state !== "idle")
      throw new HttpError(409, "Process must be idle to accept a run signal.");

    const hasExistingOutputs =
      stored.exitState !== null ||
      Object.keys(stored.output).length > 0 ||
      stored.stdout.length > 0 ||
      stored.stderr.length > 0;

    if (hasExistingOutputs && !force)
      throw new HttpError(
        400,
        "Process has existing outputs. Set force: true to overwrite.",
      );

    stored.state = "queued";
    stored.exitState = null;
    stored.error = null;

    if (force) {
      stored.output = {};
      stored.stdout = Buffer.alloc(0);
      stored.stderr = Buffer.alloc(0);
    }

    this.startExecution(pid);

    return this.project(stored);
  }

  delete(pid: number): GetProcessResult {
    const stored = this.getStored(pid);

    if (stored.state !== "idle") {
      throw new HttpError(
        409,
        "Process must be idle before it can be deleted.",
      );
    }

    this.processes.delete(pid);
    this.pidPool.push(pid);

    return this.project(stored);
  }

  async waitForIdle(
    pid: number,
    pollIntervalMs = 100,
    maxWaitMs?: number,
  ): Promise<GetProcessResult> {
    const initial = this.getStored(pid);
    const effectiveTimeoutMs =
      initial.options.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    const deadline = Date.now() + (maxWaitMs ?? effectiveTimeoutMs * 2 + 1_000);

    while (true) {
      const stored = this.getStored(pid);
      if (stored.state === "idle") return this.project(stored);
      if (Date.now() >= deadline) {
        throw new HttpError(
          504,
          `Process ${pid} did not become idle within the configured wait window.`,
        );
      }
      await this.sleep(pollIntervalMs);
    }
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    for (const pid of this.executions.keys()) {
      try {
        await this.controller.kill(pid);
      } catch {}
    }

    const pending = Array.from(this.executions.values(), (ctx) => ctx.promise);
    await Promise.allSettled(pending);
  }

  recordState(eid: number, state: ExecutionState): void {
    const stored = this.processes.get(eid);

    if (!stored || stored.state === "terminating" || stored.state === "idle")
      return;

    stored.state = state === "running" ? "running" : "queued";
  }

  recordStdout(eid: number, data: Buffer): void {
    const stored = this.processes.get(eid);
    const context = this.executions.get(eid);

    if (!stored || !context) return;

    stored.stdout = Buffer.concat([
      stored.stdout,
      Buffer.from(context.stdoutDecoder.write(data)),
    ]);
  }

  recordStderr(eid: number, data: Buffer): void {
    const stored = this.processes.get(eid);
    const context = this.executions.get(eid);

    if (!stored || !context) return;

    stored.stderr = Buffer.concat([
      stored.stderr,
      Buffer.from(context.stderrDecoder.write(data)),
    ]);
  }

  recordOutput(eid: number, data: Record<string, unknown>): void {
    const stored = this.processes.get(eid);

    if (!stored) return;

    Object.assign(stored.output, data);
  }

  recordError(eid: number, message: string): void {
    const stored = this.processes.get(eid);

    if (!stored) return;

    stored.error = message;
  }

  private startExecution(pid: number): void {
    const stored = this.processes.get(pid);

    if (!stored) return;

    const context: ExecutionContext = {
      stdoutDecoder: new StringDecoder("utf8"),
      stderrDecoder: new StringDecoder("utf8"),
      promise: Promise.resolve(),
    };
    const timeoutMs = stored.options.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;

    context.promise = this.runExecution({
      process: { pid, code: stored.code, options: { timeoutMs } },
      context,
    });

    this.executions.set(pid, context);
  }

  private async runExecution(input: RunExecutionInput): Promise<void> {
    const { pid, ...rest } = input.process;

    let exitState: ExecutionExitState;

    try {
      exitState = await this.controller.execute({ eid: pid, ...rest });
    } catch (err) {
      if (this.processes.get(pid)?.state === "terminating") {
        exitState = "canceled";
      } else {
        this.recordError(pid, errorMessage(err));
        exitState = "failed";
      }
    }

    const stored = this.processes.get(pid);
    if (!stored) {
      this.executions.delete(pid);
      return;
    }

    const flushDecoder = (decoder: StringDecoder, buf: Buffer) => {
      const remainder = decoder.end();
      return remainder.length > 0
        ? Buffer.concat([buf, Buffer.from(remainder)])
        : buf;
    };

    stored.stdout = flushDecoder(input.context.stdoutDecoder, stored.stdout);
    stored.stderr = flushDecoder(input.context.stderrDecoder, stored.stderr);
    stored.state = "idle";
    stored.exitState = exitState;

    this.executions.delete(pid);
  }

  private getStored(pid: number): ProcessRecord {
    const found = this.processes.get(pid);
    if (!found) throw new HttpError(404, "Process not found.");
    return found;
  }

  private project({
    code: _code,
    options: _options,
    output: _output,
    stdout: _stdout,
    stderr: _stderr,
    ...rest
  }: ProcessRecord): GetProcessResult {
    return rest;
  }

  private assertIdle(state: ProcessState): void {
    if (state !== "idle")
      throw new HttpError(409, "Process output is not yet available.");
  }

  private createPid(): number {
    const recycled = this.pidPool.shift();
    if (recycled !== undefined) return recycled;
    return this.nextId++;
  }

  private sleep(durationMs: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, durationMs);
    });
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
