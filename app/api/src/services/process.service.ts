import { StringDecoder } from "node:string_decoder";

import { logger } from "@/logger";
import { HttpError } from "@/models/error.model";
import type {
  Process,
  ProcessOutput,
  ProcessQueryFilters,
  ProcessState,
  StoredProcess,
} from "@/models/process.model";
import type {
  EnvironmentBuiltins,
  EnvironmentInvokeInput,
  EnvironmentModule,
  EnvironmentOutputPatch,
  ExecutionStatus,
} from "@/modules/environment.module";
import { AdapterPoolService } from "@/services/adapter-pool.service";
import type { EnvironmentPoolService } from "@/services/environment-pool.service";
import type { ManifestService } from "@/services/manifest.service";

class ProcessExecutionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessExecutionTimeoutError";
  }
}

type EnvironmentPoolRecycleApi = {
  recycleEnvironment?: (module: EnvironmentModule) => void;
  destroy?: (module: EnvironmentModule) => void;
};

type EnvironmentHealthInspectable = {
  status?: unknown;
  isHealthy?: () => boolean;
  isValid?: () => boolean;
};

export class ProcessService {
  private readonly processes = new Map<number, StoredProcess>();
  private readonly pidPool: number[] = [];
  private readonly queuedPids: number[] = [];
  private currentPid: number | null = null;
  private currentEnvironmentModule: EnvironmentModule | null = null;
  private currentExecutionPromise: Promise<void> | null = null;
  private isShuttingDown = false;
  private nextId = 1;

  constructor(
    private readonly environmentPoolService: EnvironmentPoolService,
    private readonly options: {
      executeTimeoutMs?: number;
      manifestService?: Pick<
        ManifestService,
        "discoverServices" | "discoverTools" | "getTool"
      >;
      adapterPoolService?: Pick<AdapterPoolService, "allocate" | "release">;
    } = {},
  ) {
    this.adapterPoolService =
      options.adapterPoolService ?? new AdapterPoolService();
  }

  private readonly adapterPoolService: Pick<
    AdapterPoolService,
    "allocate" | "release"
  >;

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

  create(code: string, ref?: string, timeoutMs?: number | null): number {
    if (this.isShuttingDown) {
      throw new HttpError(503, "Service is shutting down.");
    }

    if (!this.environmentPoolService.hasReadyEnvironment()) {
      throw new HttpError(503, "No staged environment is currently available.");
    }

    const pid = this.createPid();

    this.processes.set(pid, {
      process: {
        pid,
        state: "queued",
        status: null,
        ...(ref !== undefined ? { ref } : {}),
      },
      code,
      timeoutMs,
      output: {},
      stdoutChunks: [],
      stderrChunks: [],
    });

    this.enqueue(pid);
    this.drainQueue();

    return pid;
  }

  get(pid: number): Process {
    return this.getStored(pid).process;
  }

  getOutput(pid: number): ProcessOutput {
    const stored = this.getStored(pid);
    this.assertIdle(stored.process.state);
    return stored.output;
  }

  getCode(pid: number): string {
    const stored = this.getStored(pid);
    return stored.code;
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

    if (stored.process.state === "queued") {
      stored.process.state = "idle";
      stored.process.status = "canceled";
      this.removeFromQueue(pid);
      return stored.process;
    }

    if (stored.process.state === "running" && this.currentPid === pid) {
      stored.process.state = "terminating";

      if (this.currentEnvironmentModule === null) {
        const environmentModule = this.environmentPoolService.allocate();

        void environmentModule
          .kill()
          .finally(() => {
            try {
              this.environmentPoolService.release(environmentModule);
            } catch (err) {
              logger.error(
                { err, pid },
                "Failed to release environment module back to pool",
              );
            }
          })
          .catch((err: unknown) => {
            logger.warn({ err, pid }, "Failed to send kill signal to module");
          });
      } else {
        void this.currentEnvironmentModule.kill().catch((err: unknown) => {
          logger.warn({ err, pid }, "Failed to send kill signal to module");
        });
      }

      return stored.process;
    }

    stored.process.state = "idle";
    stored.process.status = "canceled";

    return stored.process;
  }

  run(pid: number, force: boolean): Process {
    if (this.isShuttingDown) {
      throw new HttpError(503, "Service is shutting down.");
    }

    if (!this.environmentPoolService.hasReadyEnvironment()) {
      throw new HttpError(503, "No staged environment is currently available.");
    }

    const stored = this.getStored(pid);

    if (stored.process.state !== "idle") {
      throw new HttpError(409, "Process must be idle to accept a run signal.");
    }

    const hasExistingOutputs =
      stored.process.status !== null ||
      Object.keys(stored.output).length > 0 ||
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
      stored.output = {};
      stored.stdoutChunks = [];
      stored.stderrChunks = [];
    }

    this.enqueue(pid);
    this.drainQueue();

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

  async waitForIdle(pid: number, pollIntervalMs = 100): Promise<Process> {
    while (true) {
      const stored = this.getStored(pid);
      if (stored.process.state === "idle") {
        return stored.process;
      }

      await this.sleep(pollIntervalMs);
    }
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    const queued = this.queuedPids.splice(0);
    for (const pid of queued) {
      const stored = this.processes.get(pid);
      if (!stored || stored.process.state !== "queued") {
        continue;
      }

      stored.process.state = "idle";
      stored.process.status = "canceled";
    }

    if (this.currentPid !== null) {
      const running = this.processes.get(this.currentPid);
      if (
        running &&
        (running.process.state === "running" ||
          running.process.state === "terminating")
      ) {
        running.process.state = "terminating";

        if (this.currentEnvironmentModule) {
          try {
            await this.currentEnvironmentModule.kill();
          } catch (err) {
            logger.warn(
              { err, pid: running.process.pid },
              "Failed to kill running process during shutdown",
            );
          }
        }
      }
    }

    if (this.currentExecutionPromise) {
      await this.currentExecutionPromise;
    }
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

  private sleep(durationMs: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, durationMs);
    });
  }

  private enqueue(pid: number): void {
    if (!this.queuedPids.includes(pid)) {
      this.queuedPids.push(pid);
    }
  }

  private removeFromQueue(pid: number): void {
    const index = this.queuedPids.indexOf(pid);
    if (index >= 0) {
      this.queuedPids.splice(index, 1);
    }
  }

  private drainQueue(): void {
    if (this.isShuttingDown) {
      return;
    }

    if (this.currentPid !== null) {
      return;
    }

    while (this.queuedPids.length > 0) {
      const pid = this.queuedPids.shift();
      if (pid === undefined) {
        return;
      }

      const stored = this.processes.get(pid);
      if (!stored || stored.process.state !== "queued") {
        continue;
      }

      this.currentPid = pid;
      const execution = this.executeProcess(pid).finally(() => {
        if (this.currentPid === pid) {
          this.currentPid = null;
        }

        if (this.currentExecutionPromise === execution) {
          this.currentExecutionPromise = null;
        }

        this.drainQueue();
      });
      this.currentExecutionPromise = execution;
      return;
    }
  }

  private async executeProcess(pid: number): Promise<void> {
    let onStdout: ((chunk: Buffer) => void) | null = null;
    let onStderr: ((chunk: Buffer) => void) | null = null;
    let onOutput: ((data: EnvironmentOutputPatch) => void) | null = null;
    let environmentModule: EnvironmentModule | null = null;
    let executionErrored = false;
    let executionTimedOut = false;

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    try {
      const queued = this.processes.get(pid);
      if (!queued || queued.process.state !== "queued") {
        return;
      }

      const stored = this.processes.get(pid);
      if (!stored || stored.process.state !== "queued") {
        return;
      }

      stored.process.state = "running";
      stored.process.status = null;

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

      onOutput = (data: EnvironmentOutputPatch) => {
        const current = this.processes.get(pid);
        if (!current) {
          return;
        }

        current.output[data.key] = data.value;
      };

      environmentModule = this.environmentPoolService.allocate();
      this.currentEnvironmentModule = environmentModule;

      environmentModule.on("stdout", onStdout);
      environmentModule.on("stderr", onStderr);
      environmentModule.on("output", onOutput);

      const defaultTimeoutMs = this.options.executeTimeoutMs ?? 30_000;
      const timeoutMs =
        stored.timeoutMs === undefined ? defaultTimeoutMs : stored.timeoutMs;

      const builtins = this.createEnvironmentBuiltins();

      const execution = environmentModule.execute(stored.code, {
        timeoutMs,
        ...(builtins ? { builtins } : {}),
      });
      const status =
        timeoutMs === null
          ? await execution
          : await this.executeWithTimeout(execution, timeoutMs);

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
      executionErrored = true;
      executionTimedOut = err instanceof ProcessExecutionTimeoutError;

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
      if (environmentModule && onStdout) {
        environmentModule.off("stdout", onStdout);
      }

      if (environmentModule && onStderr) {
        environmentModule.off("stderr", onStderr);
      }

      if (environmentModule && onOutput) {
        environmentModule.off("output", onOutput);
      }

      if (this.currentEnvironmentModule === environmentModule) {
        this.currentEnvironmentModule = null;
      }

      if (environmentModule) {
        const shouldRecycle =
          executionTimedOut ||
          executionErrored ||
          !this.isEnvironmentModuleHealthy(environmentModule, pid);

        if (shouldRecycle) {
          this.recycleEnvironmentModule(environmentModule, pid);
        } else {
          try {
            this.environmentPoolService.release(environmentModule);
          } catch (err) {
            logger.error(
              { err, pid },
              "Failed to release environment module back to pool",
            );
          }
        }
      }
    }
  }

  private recycleEnvironmentModule(
    environmentModule: EnvironmentModule,
    pid: number,
  ): void {
    const poolWithRecycle = this
      .environmentPoolService as EnvironmentPoolService &
      EnvironmentPoolRecycleApi;

    try {
      if (typeof poolWithRecycle.recycleEnvironment === "function") {
        poolWithRecycle.recycleEnvironment(environmentModule);
        return;
      }

      if (typeof poolWithRecycle.destroy === "function") {
        poolWithRecycle.destroy(environmentModule);
        return;
      }

      void environmentModule.kill().catch((err: unknown) => {
        logger.warn(
          { err, pid },
          "Failed to kill unhealthy environment module before release",
        );
      });

      this.environmentPoolService.release(environmentModule);
    } catch (err) {
      logger.error(
        { err, pid },
        "Failed to recycle environment module in pool",
      );
    }
  }

  private isEnvironmentModuleHealthy(
    environmentModule: EnvironmentModule,
    pid: number,
  ): boolean {
    const inspectable = environmentModule as EnvironmentModule &
      EnvironmentHealthInspectable;

    if (typeof inspectable.isHealthy === "function") {
      try {
        if (!inspectable.isHealthy()) {
          return false;
        }
      } catch (err) {
        logger.warn({ err, pid }, "Environment module isHealthy() check threw");
        return false;
      }
    }

    if (typeof inspectable.isValid === "function") {
      try {
        if (!inspectable.isValid()) {
          return false;
        }
      } catch (err) {
        logger.warn({ err, pid }, "Environment module isValid() check threw");
        return false;
      }
    }

    if (typeof inspectable.status === "string") {
      const status = inspectable.status.toLowerCase();
      if (
        status === "timeout" ||
        status === "timed_out" ||
        status === "error" ||
        status === "failed" ||
        status === "unhealthy" ||
        status === "invalid"
      ) {
        return false;
      }
    }

    return true;
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

  private createEnvironmentBuiltins(): EnvironmentBuiltins | undefined {
    if (!this.options.manifestService) {
      return undefined;
    }

    const { manifestService } = this.options;

    return {
      tools: {
        discover: ({ query, limit, enabled }) =>
          enabled === undefined
            ? manifestService.discoverTools(query, limit)
            : manifestService.discoverTools(query, limit, enabled),
        invoke: (input) => this.invokeToolFromManifest(input),
      },
      services: {
        discover: ({ query, limit, enabled }) =>
          enabled === undefined
            ? manifestService.discoverServices(query, limit)
            : manifestService.discoverServices(query, limit, enabled),
      },
    };
  }

  private async invokeToolFromManifest(
    input: EnvironmentInvokeInput,
  ): Promise<unknown> {
    const manifestService = this.options.manifestService;

    if (!manifestService) {
      throw new Error("Manifest service is not configured.");
    }

    const tool = await manifestService.getTool(
      input.serviceName,
      input.toolName,
    );

    if (!tool.serviceEnabled) {
      throw new Error(
        `Service '${input.serviceName}' is disabled and cannot be invoked.`,
      );
    }

    if (!tool.tool.enabled) {
      throw new Error(
        `Tool '${input.toolName}' in service '${input.serviceName}' is disabled and cannot be invoked.`,
      );
    }

    const adapter = this.adapterPoolService.allocate();

    try {
      return await adapter.invoke(input.toolName, input.parameters, {
        serviceMetadata: tool.serviceMetadata,
        toolMetadata: tool.tool.metadata,
      });
    } finally {
      this.adapterPoolService.release(adapter);
    }
  }
}
