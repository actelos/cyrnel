import { StringDecoder } from "node:string_decoder";

import type {
  ExecutionExitState,
  ExecutionInput,
  ExecutionState,
} from "@cyrnel/sdk";
import { and, desc, eq, isNotNull, isNull, type SQL, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  processData as processDataTable,
  processes as processesTable,
} from "@/db/schema";
import { logger } from "@/infra/logging";
import { HttpError } from "@/models/error.model";
import type {
  CreateProcessInput,
  FilterProcessInput,
  GetProcessResult,
  ProcessRecord,
  ProcessState,
} from "@/models/process.model";
import {
  decodeCursor,
  invalidCursorError,
  keysetConditions,
  PAGINATION_DEFAULT_LIMIT,
  type PaginatedResult,
  paginatePage,
} from "@/utils/pagination.util";

const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ACTIVE_PROCESSES = 1_000;

function getMaxActiveProcesses(): number {
  const value = Number(process.env.CYRNEL_MAX_ACTIVE_PROCESSES);
  return Number.isInteger(value) && value >= 1
    ? value
    : DEFAULT_MAX_ACTIVE_PROCESSES;
}

let maxIdleWarningLogged = false;

function getMaxIdleProcesses(): number | null {
  const raw = process.env.CYRNEL_MAX_IDLE_PROCESSES;
  if (raw === undefined || raw.trim().length === 0) return null;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= 1) return value;
  if (!maxIdleWarningLogged) {
    maxIdleWarningLogged = true;
    logger.warn(
      { event: "max-idle-processes-invalid", raw },
      "CYRNEL_MAX_IDLE_PROCESSES must be a positive integer; treating as unlimited",
    );
  }
  return null;
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

export type DbProcessRow = {
  id: number;
  ref: string | null;
  code: string;
  timeoutMs: number | null;
  envConfig: Record<string, unknown>;
  createdAt: string;
  exitState: string | null;
  error: string | null;
  completedAt: string | null;
};

export class ProcessService {
  private readonly executions = new Map<number, ExecutionContext>();
  private readonly processes = new Map<number, ProcessRecord>();
  private readonly pidIndex = new Map<number, number>();
  private readonly pidPool: number[] = [];
  private isShuttingDown = false;
  private nextId = 1;

  constructor(private readonly controller: EnvironmentController) {}

  async list(
    filters: FilterProcessInput,
  ): Promise<PaginatedResult<GetProcessResult>> {
    const limit = filters.limit ?? PAGINATION_DEFAULT_LIMIT;
    const cursor =
      filters.cursor !== undefined
        ? decodeCursor(filters.cursor, 2)
        : undefined;

    const conditions: SQL[] = [];
    let cursorCreatedAt: string | undefined;
    let cursorId: number | undefined;
    if (cursor !== undefined) {
      const [createdAt, id] = cursor.sortKey;
      if (typeof createdAt !== "string" || typeof id !== "number") {
        throw invalidCursorError();
      }
      cursorCreatedAt = createdAt;
      cursorId = id;
      const predicate = keysetConditions(
        [
          [processesTable.createdAt, createdAt],
          [processesTable.id, id],
        ],
        "before",
      );
      if (predicate) conditions.push(predicate);
    }
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
      } else {
        conditions.push(sql`1 = 0`);
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
      .orderBy(desc(processesTable.createdAt), desc(processesTable.id))
      .limit(limit + 1 + this.processes.size)
      .all();

    const inMemory = Array.from(this.processes.values())
      .filter(
        (process) =>
          (!filters.state || process.state === filters.state) &&
          (filters.exitState === undefined ||
            process.exitState === filters.exitState) &&
          (filters.ref === undefined || process.ref === filters.ref),
      )
      .map((p) => this.project(p));

    const inMemoryIds = new Set(this.pidIndex.keys());
    const merged: GetProcessResult[] = [...inMemory];
    for (const row of dbRows) {
      if (inMemoryIds.has(row.id)) continue;
      merged.push({
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

    merged.sort((a, b) =>
      a.createdAt === b.createdAt
        ? b.id - a.id
        : a.createdAt < b.createdAt
          ? 1
          : -1,
    );

    const filtered =
      cursorCreatedAt === undefined || cursorId === undefined
        ? merged
        : merged.filter(
            (row) =>
              row.createdAt < cursorCreatedAt ||
              (row.createdAt === cursorCreatedAt && row.id < cursorId),
          );

    return paginatePage(filtered.slice(0, limit + 1), limit, (row) => [
      row.createdAt,
      row.id,
    ]);
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
      lastExecutedAt: Date.now(),
      createdAt,
    });

    if (autorun) {
      this.startExecution(id);
    } else {
      this.trimIdleProcesses();
    }

    return { id };
  }

  async get(id: number): Promise<GetProcessResult> {
    const pid = this.pidIndex.get(id);
    if (pid !== undefined) {
      return this.project(this.getStored(pid));
    }

    const row = await this.loadDbProcess(id);
    if (!row) throw new HttpError(404, "Process not found.");

    return this.projectDbProcess(row);
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
    const pid = this.pidIndex.get(id);

    if (pid === undefined) {
      const row = await this.loadDbProcess(id);
      if (!row) throw new HttpError(404, "Process not found.");
      throw new HttpError(409, "Process is already idle.");
    }

    const stored = this.getStored(pid);

    if (stored.state === "idle")
      throw new HttpError(409, "Process is already idle.");
    if (stored.state === "terminating") return await this.get(id);

    stored.state = "terminating";

    this.controller.kill(pid).catch((err) => {
      logger.warn(
        { event: "kill-signal-failed", err, processId: id, pid },
        "Failed to send kill signal",
      );
    });

    return await this.get(id);
  }

  async run(id: number, force: boolean): Promise<GetProcessResult> {
    if (this.isShuttingDown)
      throw new HttpError(503, "Service is shutting down.");

    const pid = this.pidIndex.get(id);

    if (pid === undefined) {
      return await this.reviveFromDb(id, force);
    }

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

  async unload(id: number): Promise<GetProcessResult> {
    const pid = this.pidIndex.get(id);

    if (pid === undefined) {
      const row = await this.loadDbProcess(id);
      if (!row) throw new HttpError(404, "Process not found.");
      throw new HttpError(409, "Process is not in active memory.");
    }

    const stored = this.getStored(pid);

    if (stored.state !== "idle") {
      throw new HttpError(
        409,
        "Process must be idle before it can be unloaded.",
      );
    }

    this.releaseFromMemory(pid);

    const row = await this.loadDbProcess(id);
    if (!row) throw new HttpError(404, "Process not found.");

    return this.projectDbProcess(row);
  }

  async delete(id: number): Promise<GetProcessResult> {
    const pid = this.pidIndex.get(id);

    if (pid === undefined) {
      const row = await this.loadDbProcess(id);
      if (!row) throw new HttpError(404, "Process not found.");

      const result = this.projectDbProcess(row);

      try {
        await db.delete(processesTable).where(eq(processesTable.id, id));
      } catch (err) {
        logger.error(
          { event: "process-delete-failed", err, processId: id },
          "Failed to delete process from database",
        );
        throw new HttpError(500, "Failed to delete process.");
      }

      return result;
    }

    const stored = this.getStored(pid);

    if (stored.state !== "idle") {
      throw new HttpError(
        409,
        "Process must be idle before it can be deleted.",
      );
    }

    const result = this.project(stored);

    this.releaseFromMemory(pid);

    try {
      await db.delete(processesTable).where(eq(processesTable.id, id));
    } catch (err) {
      this.restoreToMemory(pid, stored);
      logger.error(
        { event: "process-delete-failed", err, processId: id },
        "Failed to delete process from database",
      );
      throw new HttpError(500, "Failed to delete process.");
    }

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

    stored.lastExecutedAt = Date.now();

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
            {
              event: "kill-on-timeout-failed",
              err,
              processId: stored.dbId,
              pid: stored.pid,
            },
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

    const payload = {
      processId: stored.dbId,
      exitState,
      error: stored.error,
      output: stored.output,
      stdout: stored.stdout.toString("utf8"),
      stderr: stored.stderr.toString("utf8"),
      completedAt: new Date().toISOString(),
    };

    let persisted = true;
    try {
      await db.insert(processDataTable).values(payload).onConflictDoUpdate({
        target: processDataTable.processId,
        set: payload,
      });
    } catch (err) {
      persisted = false;
      logger.warn(
        { event: "process-result-persist-failed", err, processId: stored.dbId },
        "Failed to persist process result",
      );
    }

    if (persisted) {
      this.trimIdleProcesses();
    }
  }

  private resolvePid(id: number): number {
    const pid = this.pidIndex.get(id);
    if (pid === undefined)
      throw new HttpError(404, "Process not found in active memory.");
    return pid;
  }

  private async reviveFromDb(
    id: number,
    force: boolean,
  ): Promise<GetProcessResult> {
    const row = await this.loadDbProcess(id);
    if (!row) throw new HttpError(404, "Process not found.");

    if (row.completedAt !== null && !force) {
      throw new HttpError(
        400,
        "Process has existing outputs. Set force: true to overwrite.",
      );
    }

    const maxActiveProcesses = getMaxActiveProcesses();
    if (this.processes.size >= maxActiveProcesses) {
      throw new HttpError(
        429,
        `Too many active processes (${this.processes.size} >= ${maxActiveProcesses}).`,
      );
    }

    const pid = this.createPid();

    this.pidIndex.set(id, pid);
    this.processes.set(pid, {
      dbId: id,
      pid,
      ref: row.ref ?? undefined,
      state: "queued",
      exitState: null,
      error: null,
      code: row.code,
      timeoutMs: row.timeoutMs,
      envConfig: row.envConfig,
      autorun: true,
      output: {},
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      lastExecutedAt: Date.now(),
      createdAt: row.createdAt,
    });

    this.startExecution(id);

    return await this.get(id);
  }

  private async loadDbProcess(id: number): Promise<DbProcessRow | null> {
    const [row] = await db
      .select({
        id: processesTable.id,
        ref: processesTable.ref,
        code: processesTable.code,
        timeoutMs: processesTable.timeoutMs,
        envConfig: processesTable.envConfig,
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

    return row ?? null;
  }

  private projectDbProcess(row: DbProcessRow): GetProcessResult {
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

  private getStored(pid: number): ProcessRecord {
    const found = this.processes.get(pid);
    if (!found) throw new HttpError(404, "Process not found.");
    return found;
  }

  private releaseFromMemory(pid: number): void {
    const stored = this.processes.get(pid);
    if (!stored) return;
    this.processes.delete(pid);
    this.pidIndex.delete(stored.dbId);
    this.pidPool.push(pid);
  }

  private restoreToMemory(pid: number, stored: ProcessRecord): void {
    const poolIndex = this.pidPool.indexOf(pid);
    if (poolIndex !== -1) this.pidPool.splice(poolIndex, 1);
    this.processes.set(pid, stored);
    this.pidIndex.set(stored.dbId, pid);
  }

  private trimIdleProcesses(): void {
    const maxIdle = getMaxIdleProcesses();
    if (maxIdle === null) return;

    const idle = Array.from(this.processes.entries())
      .filter(([, stored]) => stored.state === "idle")
      .sort((a, b) => a[1].lastExecutedAt - b[1].lastExecutedAt);

    for (let i = 0; i < idle.length - maxIdle; i++) {
      this.releaseFromMemory(idle[i][0]);
    }
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
      createdAt: record.createdAt,
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
