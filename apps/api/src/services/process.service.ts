import { StringDecoder } from "node:string_decoder";

import type {
  ExecutionExitState,
  ExecutionInput,
  ExecutionState,
} from "@cyrnel/sdk";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";

import { db } from "@/db/client";
import {
  processData as processDataTable,
  processes as processesTable,
} from "@/db/schema";
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
const DEFAULT_MAX_ACTIVE_PROCESSES = 1_000;

function getMaxActiveProcesses(): number {
  const value = Number(process.env.CYRNEL_MAX_ACTIVE_PROCESSES);
  return Number.isInteger(value) && value >= 1
    ? value
    : DEFAULT_MAX_ACTIVE_PROCESSES;
}

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
    id: number;
    pid: number;
    code: string;
    envConfig: Record<string, unknown>;
  };
  context: ExecutionContext;
}

export class ProcessService {
  private readonly executions = new Map<number, ExecutionContext>();
  private readonly processes = new Map<number, ProcessRecord>();
  private readonly pidIndex = new Map<number, number>();
  private readonly pidPool: number[] = [];
  private isShuttingDown = false;
  private nextId = 1;

  constructor(private readonly controller: EnvironmentController) {}

  async list(filters: FilterProcessInput): Promise<GetProcessResult[]> {
    const inMemory = Array.from(this.processes.values())
      .filter(
        (process) =>
          (!filters.state || process.state === filters.state) &&
          (filters.exitState === undefined ||
            process.exitState === filters.exitState) &&
          (filters.ref === undefined || process.ref === filters.ref),
      )
      .map((p) => this.project(p));

    const conditions = [];
    if (filters.ref !== undefined) {
      conditions.push(eq(processesTable.ref, filters.ref));
    }

    if (filters.exitState !== undefined) {
      if (filters.exitState === null) {
        conditions.push(isNull(processDataTable.exitState));
      } else {
        conditions.push(eq(processDataTable.exitState, filters.exitState));
      }
    }

    if (filters.state !== undefined) {
      if (filters.state === "idle") {
        conditions.push(isNotNull(processDataTable.exitState));
      }
    }

    const dbRows = await db
      .select({
        id: processesTable.id,
        ref: processesTable.ref,
        createdAt: processesTable.createdAt,
        exitState: processDataTable.exitState,
        error: processDataTable.error,
        completedAt: processDataTable.completedAt,
      })
      .from(processesTable)
      .leftJoin(
        processDataTable,
        eq(processDataTable.processId, processesTable.id),
      )
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(processesTable.id))
      .all();

    const inMemoryIds = new Set(this.pidIndex.keys());
    const dbOnly: GetProcessResult[] = [];
    for (const row of dbRows) {
      if (inMemoryIds.has(row.id)) continue;
      dbOnly.push({
        id: row.id,
        pid: null,
        ref: row.ref ?? undefined,
        state: "idle",
        exitState: (row.exitState ?? null) as GetProcessResult["exitState"],
        error: row.error,
        createdAt: row.createdAt,
        completedAt: row.completedAt,
      });
    }

    return [...inMemory, ...dbOnly];
  }

  async create(input: CreateProcessInput): Promise<{ id: number }> {
    if (this.isShuttingDown) {
      throw new HttpError(503, "Service is shutting down.");
    }

    const maxActiveProcesses = getMaxActiveProcesses();
    if (this.processes.size >= maxActiveProcesses) {
      throw new HttpError(
        429,
        `Too many active processes (${this.processes.size} >= ${maxActiveProcesses}).`,
      );
    }

    const autorun = input.autorun ?? true;
    const createdAt = new Date().toISOString();
    const timeoutMs =
      input.timeoutMs !== undefined
        ? input.timeoutMs
        : DEFAULT_EXECUTION_TIMEOUT_MS;
    const envConfig = input.envConfig ?? {};

    const [{ id }] = await db
      .insert(processesTable)
      .values({
        ref: input.ref ?? null,
        code: input.code,
        timeoutMs: timeoutMs,
        envConfig,
        createdAt,
      })
      .returning({ id: processesTable.id });

    const pid = this.createPid();

    this.pidIndex.set(id, pid);
    this.processes.set(pid, {
      dbId: id,
      pid,
      ref: input.ref,
      state: autorun ? "queued" : "idle",
      exitState: null,
      error: null,
      code: input.code,
      timeoutMs,
      envConfig,
      autorun,
      output: {},
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });

    if (autorun) {
      this.startExecution(id);
    }

    return { id };
  }

  async get(id: number): Promise<GetProcessResult> {
    const pid = this.pidIndex.get(id);
    if (pid !== undefined) {
      return this.project(this.getStored(pid));
    }

    const [row] = await db
      .select({
        id: processesTable.id,
        ref: processesTable.ref,
        createdAt: processesTable.createdAt,
        exitState: processDataTable.exitState,
        error: processDataTable.error,
        completedAt: processDataTable.completedAt,
      })
      .from(processesTable)
      .leftJoin(
        processDataTable,
        eq(processDataTable.processId, processesTable.id),
      )
      .where(eq(processesTable.id, id))
      .limit(1)
      .all();

    if (!row) throw new HttpError(404, "Process not found.");

    return {
      id: row.id,
      pid: null,
      ref: row.ref ?? undefined,
      state: "idle",
      exitState: (row.exitState ?? null) as GetProcessResult["exitState"],
      error: row.error,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
    };
  }

  async getOutput(id: number): Promise<Record<string, unknown>> {
    const pid = this.pidIndex.get(id);
    if (pid !== undefined) {
      const stored = this.getStored(pid);
      this.assertIdle(stored.state);
      return stored.output;
    }
    const data = await this.resolveDbData(id);
    return data.output ?? {};
  }

  async getCode(id: number): Promise<string> {
    const pid = this.pidIndex.get(id);
    if (pid !== undefined) {
      const stored = this.getStored(pid);
      return stored.code;
    }
    const [row] = await db
      .select({ code: processesTable.code })
      .from(processesTable)
      .where(eq(processesTable.id, id))
      .limit(1)
      .all();
    if (!row) throw new HttpError(404, "Process not found.");
    return row.code;
  }

  async getStdout(id: number): Promise<string> {
    const pid = this.pidIndex.get(id);
    if (pid !== undefined) {
      const stored = this.getStored(pid);
      this.assertIdle(stored.state);
      return stored.stdout.toString("utf8");
    }
    const data = await this.resolveDbData(id);
    return data.stdout ?? "";
  }

  async getStderr(id: number): Promise<string> {
    const pid = this.pidIndex.get(id);
    if (pid !== undefined) {
      const stored = this.getStored(pid);
      this.assertIdle(stored.state);
      return stored.stderr.toString("utf8");
    }
    const data = await this.resolveDbData(id);
    return data.stderr ?? "";
  }

  async kill(id: number): Promise<GetProcessResult> {
    const pid = this.resolvePid(id);
    const stored = this.getStored(pid);

    if (stored.state === "idle")
      throw new HttpError(409, "Process is already idle.");
    if (stored.state === "terminating") return await this.get(id);

    stored.state = "terminating";

    this.controller.kill(pid).catch((err) => {
      logger.warn({ err, pid }, "Failed to send kill signal");
    });

    return await this.get(id);
  }

  async run(id: number, force: boolean): Promise<GetProcessResult> {
    if (this.isShuttingDown)
      throw new HttpError(503, "Service is shutting down.");

    const pid = this.resolvePid(id);
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

    this.startExecution(id);

    return await this.get(id);
  }

  async delete(id: number): Promise<GetProcessResult> {
    const pid = this.resolvePid(id);
    const stored = this.getStored(pid);

    if (stored.state !== "idle") {
      throw new HttpError(
        409,
        "Process must be idle before it can be deleted.",
      );
    }

    const result = this.project(stored);

    this.processes.delete(pid);
    this.pidIndex.delete(id);
    this.pidPool.push(pid);

    await db
      .delete(processesTable)
      .where(eq(processesTable.id, id))
      .catch((err) => {
        logger.warn({ err, id }, "Failed to delete process from database");
      });

    return result;
  }

  async waitForIdle(
    id: number,
    pollIntervalMs = 100,
    maxWaitMs?: number,
  ): Promise<GetProcessResult> {
    const pid = this.resolvePid(id);
    const initial = this.getStored(pid);
    const effectiveTimeoutMs =
      initial.timeoutMs !== undefined
        ? initial.timeoutMs
        : DEFAULT_EXECUTION_TIMEOUT_MS;
    const deadline =
      effectiveTimeoutMs !== null
        ? Date.now() + (maxWaitMs ?? effectiveTimeoutMs * 2 + 1_000)
        : maxWaitMs !== undefined
          ? Date.now() + maxWaitMs
          : Date.now() + DEFAULT_EXECUTION_TIMEOUT_MS * 2 + 1_000;

    while (true) {
      const stored = this.processes.get(pid);
      if (!stored || stored.state === "idle") return await this.get(id);
      if (Date.now() >= deadline) {
        throw new HttpError(
          504,
          `Process ${id} did not become idle within the configured wait window.`,
        );
      }
      await this.sleep(pollIntervalMs);
    }
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    for (const [pid] of this.executions) {
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

  private startExecution(id: number): void {
    const stored = this.processes.get(this.pidIndex.get(id) ?? -1);

    if (!stored) return;

    const context: ExecutionContext = {
      stdoutDecoder: new StringDecoder("utf8"),
      stderrDecoder: new StringDecoder("utf8"),
      promise: Promise.resolve(),
    };

    context.promise = this.runExecution({
      process: {
        id,
        pid: stored.pid,
        code: stored.code,
        envConfig: stored.envConfig,
      },
      context,
    });

    if (stored.timeoutMs !== null) {
      const timeoutHandle = setTimeout(() => {
        this.controller.kill(stored.pid).catch((err) => {
          logger.warn(
            { err, pid: stored.pid },
            "Failed to kill process on timeout",
          );
        });
        const s = this.processes.get(stored.pid);
        if (s && s.state !== "idle") {
          s.state = "idle";
          s.exitState = "timeout";
        }
      }, stored.timeoutMs);
      context.promise = context.promise.then(() => {
        clearTimeout(timeoutHandle);
      });
    }

    this.executions.set(stored.pid, context);
  }

  private async runExecution(input: RunExecutionInput): Promise<void> {
    const { pid, code, envConfig } = input.process;

    let exitState: ExecutionExitState;

    try {
      exitState = await this.controller.execute({ eid: pid, code, envConfig });
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

    try {
      await db.insert(processDataTable).values({
        processId: stored.dbId,
        exitState,
        error: stored.error,
        output: stored.output,
        stdout: stored.stdout.toString("utf8"),
        stderr: stored.stderr.toString("utf8"),
        completedAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn({ err, id: stored.dbId }, "Failed to persist process result");
    }
  }

  private resolvePid(id: number): number {
    const pid = this.pidIndex.get(id);
    if (pid === undefined)
      throw new HttpError(404, "Process not found in active memory.");
    return pid;
  }

  private getStored(pid: number): ProcessRecord {
    const found = this.processes.get(pid);
    if (!found) throw new HttpError(404, "Process not found.");
    return found;
  }

  private async resolveDbData(id: number): Promise<{
    output: Record<string, unknown> | null;
    stdout: string | null;
    stderr: string | null;
  }> {
    const [row] = await db
      .select({
        output: processDataTable.output,
        stdout: processDataTable.stdout,
        stderr: processDataTable.stderr,
      })
      .from(processDataTable)
      .where(eq(processDataTable.processId, id))
      .limit(1)
      .all();
    if (!row) throw new HttpError(404, "Process data not found.");
    return row;
  }

  private project(record: ProcessRecord): GetProcessResult {
    return {
      id: record.dbId,
      pid: record.pid,
      ref: record.ref,
      state: record.state,
      exitState: record.exitState,
      error: record.error,
      createdAt: "",
      completedAt: null,
    };
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
