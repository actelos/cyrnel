import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { Worker } from "node:worker_threads";
import ts from "typescript";

import type { ProcessStatus } from "@/models/process.model";

export type ExecutionStatus = Extract<ProcessStatus, "success" | "failed">;

export interface EnvironmentDiscoverInput {
  query: string;
  limit?: number;
}

export interface EnvironmentBuiltins {
  tools?: {
    discover?: (input: EnvironmentDiscoverInput) => Promise<unknown>;
  };
  services?: {
    discover?: (input: EnvironmentDiscoverInput) => Promise<unknown>;
  };
}

interface ExecuteOptions {
  timeoutMs?: number | null;
  builtins?: EnvironmentBuiltins;
}

export interface EnvironmentOutputPatch {
  key: string;
  value: unknown;
}

interface WorkerOutputMessage {
  type: "output";
  data: EnvironmentOutputPatch;
}

interface WorkerResultMessage {
  type: "result";
  data: unknown;
}

interface WorkerFailureMessage {
  type: "failure";
  error: { message: string; stack?: string };
}

interface WorkerBuiltinRequestMessage {
  type: "builtin.request";
  request: {
    requestId: string;
    builtin: "discover.tools" | "discover.services";
    payload: unknown;
  };
}

type WorkerMessage =
  | WorkerOutputMessage
  | WorkerResultMessage
  | WorkerFailureMessage
  | WorkerBuiltinRequestMessage;

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

export class EnvironmentModule extends EventEmitter {
  private killed = false;
  private worker: Worker | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  async execute(
    code: string,
    { timeoutMs, builtins }: ExecuteOptions = {},
  ): Promise<ExecutionStatus> {
    if (this.worker) {
      throw new Error("Execution already in progress");
    }

    this.killed = false;

    const transpiled = transpileTypeScript(code);
    const worker = this.createWorker(transpiled, builtins !== undefined);

    this.worker = worker;

    const effectiveTimeoutMs =
      timeoutMs === undefined || timeoutMs === null ? 2_147_483_647 : timeoutMs;

    return new Promise<ExecutionStatus>((resolve, reject) => {
      let settled = false;
      let outputBytes = 0;
      let pendingStatus: ExecutionStatus | null = null;

      const stdoutDone = this.waitForStreamDrain(worker.stdout);
      const stderrDone = this.waitForStreamDrain(worker.stderr);

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const settleResolved = (status: ExecutionStatus) => {
        if (settled) return;

        void Promise.all([stdoutDone, stderrDone])
          .then(() => {
            settle(() => resolve(status));
          })
          .catch((err) => {
            settle(() => reject(err));
          });
      };

      const cleanup = () => {
        if (this.timeoutHandle !== null) {
          clearTimeout(this.timeoutHandle);
          this.timeoutHandle = null;
        }

        this.detachStream(worker.stdout);
        this.detachStream(worker.stderr);

        worker.removeAllListeners();

        this.worker = null;
      };

      this.timeoutHandle = setTimeout(async () => {
        pendingStatus = "failed";

        this.emit(
          "stderr",
          Buffer.from(`Execution timed out after ${effectiveTimeoutMs}ms`),
        );

        await worker.terminate();

        settleResolved("failed");
      }, effectiveTimeoutMs);

      worker.on("message", (message: WorkerMessage) => {
        if (message.type === "output") {
          this.emit("output", message.data);
          return;
        }

        if (message.type === "result") {
          if (message.data !== undefined) {
            this.emit("output", { key: "result", value: message.data });
          }
          pendingStatus = "success";
          return;
        }

        if (message.type === "failure") {
          if (message.error?.message) {
            this.emit("stderr", Buffer.from(message.error.message));
          }
          pendingStatus = "failed";
          return;
        }

        if (message.type === "builtin.request") {
          void this.handleBuiltinRequest(
            worker,
            message.request,
            builtins,
          ).catch((error: unknown) => {
            worker.postMessage({
              type: "builtin.error",
              requestId: message.request.requestId,
              error: {
                message:
                  error instanceof Error
                    ? error.message
                    : String(error ?? "Unknown builtin error"),
              },
            });
          });
        }
      });

      worker.on("error", (err) => {
        settle(() => reject(err));
      });

      worker.on("exit", (code) => {
        if (settled) return;

        if (pendingStatus) {
          settleResolved(pendingStatus);
          return;
        }

        if (code === 0) {
          settleResolved("failed");
        } else if (this.killed) {
          settleResolved("failed");
        } else {
          settle(() =>
            reject(new Error(`Worker exited unexpectedly with code ${code}`)),
          );
        }
      });

      this.attachStream(
        worker.stdout,
        "stdout",
        () => outputBytes,
        (n) => {
          outputBytes += n;
        },
      );
      this.attachStream(
        worker.stderr,
        "stderr",
        () => outputBytes,
        (n) => {
          outputBytes += n;
        },
      );
    });
  }

  async kill(): Promise<void> {
    if (!this.worker) return;

    this.killed = true;

    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }

    await this.worker.terminate();
    this.worker = null;
  }

  private attachStream(
    stream: Readable | null,
    event: "stdout" | "stderr",
    getBytes: () => number,
    addBytes: (n: number) => void,
  ): void {
    if (!stream) return;

    const handler = (chunk: Buffer) => {
      if (getBytes() + chunk.byteLength > MAX_OUTPUT_BYTES) {
        this.emit(
          "stderr",
          Buffer.from(
            `Output limit of ${MAX_OUTPUT_BYTES} bytes exceeded; truncating.`,
          ),
        );
        stream.removeListener("data", handler);
        return;
      }
      addBytes(chunk.byteLength);
      this.emit(event, chunk);
    };

    stream.on("data", handler);
  }

  private waitForStreamDrain(stream: Readable | null): Promise<void> {
    if (!stream) {
      return Promise.resolve();
    }

    if (stream.readableEnded || stream.destroyed) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const done = () => {
        stream.removeListener("end", done);
        stream.removeListener("close", done);
        stream.removeListener("error", done);
        resolve();
      };

      stream.once("end", done);
      stream.once("close", done);
      stream.once("error", done);
    });
  }

  private detachStream(stream: Readable | null): void {
    stream?.removeAllListeners("data");
    stream?.removeAllListeners("close");

    const refCounted = stream as Readable & { unref?: () => void };
    refCounted?.unref?.();
  }

  private createWorker(transpiledCode: string, hasBuiltins: boolean): Worker {
    return new Worker(
      `
        const { parentPort, workerData } = require("node:worker_threads");
        const pendingBuiltinRequests = new Map();
        let nextBuiltinRequestId = 1;
        const hasBuiltins = workerData.hasBuiltins === true;

        const onBuiltinMessage = (message) => {
          if (!message || typeof message !== "object") {
            return;
          }

          if (message.type !== "builtin.response" && message.type !== "builtin.error") {
            return;
          }

          const pending = pendingBuiltinRequests.get(message.requestId);
          if (!pending) {
            return;
          }

          pendingBuiltinRequests.delete(message.requestId);

          if (message.type === "builtin.response") {
            pending.resolve(message.data);
            return;
          }

          const errorMessage =
            message.error && typeof message.error.message === "string"
              ? message.error.message
              : "Unknown builtin error";
          pending.reject(new Error(errorMessage));
        };

        if (hasBuiltins) {
          parentPort.on("message", onBuiltinMessage);
        }

        function emitOutput(keyOrValue, value) {
          if (arguments.length === 1) {
            parentPort.postMessage({ type: "output", data: { key: "result", value: keyOrValue } });
            return;
          }

          const key = typeof keyOrValue === "string" && keyOrValue.length > 0
            ? keyOrValue
            : "result";

          parentPort.postMessage({ type: "output", data: { key, value } });
        }

        function callBuiltin(builtin, payload) {
          if (!hasBuiltins) {
            return Promise.reject(new Error("Builtin channel is not enabled."));
          }

          return new Promise((resolve, reject) => {
            const requestId = String(nextBuiltinRequestId++);
            pendingBuiltinRequests.set(requestId, { resolve, reject });
            parentPort.postMessage({
              type: "builtin.request",
              request: {
                requestId,
                builtin,
                payload,
              },
            });
          });
        }

        const tools = Object.freeze({
          discover: async (input) => callBuiltin("discover.tools", input),
        });

        const services = Object.freeze({
          discover: async (input) => callBuiltin("discover.services", input),
        });

        const runUserCode = async () => {
          const runner = new Function("emitOutput", "tools", "services", '"use strict"; return (async () => {\\n' + workerData.code + '\\n})();');
          return runner(emitOutput, tools, services);
        };
        runUserCode()
          .then((result) => {
            if (hasBuiltins) {
              parentPort.off("message", onBuiltinMessage);
            }

            parentPort.postMessage({ type: "result", data: result });
          })
          .catch((error) => {
            if (hasBuiltins) {
              parentPort.off("message", onBuiltinMessage);
            }

            parentPort.postMessage({
              type: "failure",
              error: error instanceof Error
                ? { message: error.message, stack: error.stack }
                : { message: String(error) },
            });
          });
      `,
      {
        eval: true,
        stdout: true,
        stderr: true,
        workerData: { code: transpiledCode, hasBuiltins },
      },
    );
  }

  private async handleBuiltinRequest(
    worker: Worker,
    request: WorkerBuiltinRequestMessage["request"],
    builtins: EnvironmentBuiltins | undefined,
  ): Promise<void> {
    const payload = normalizeDiscoverInput(request.payload);

    if (request.builtin === "discover.tools") {
      if (!builtins?.tools?.discover) {
        throw new Error("Builtin 'discover.tools' is not configured.");
      }

      const data = await builtins.tools.discover(payload);
      worker.postMessage({
        type: "builtin.response",
        requestId: request.requestId,
        data,
      });
      return;
    }

    if (!builtins?.services?.discover) {
      throw new Error("Builtin 'discover.services' is not configured.");
    }

    const data = await builtins.services.discover(payload);
    worker.postMessage({
      type: "builtin.response",
      requestId: request.requestId,
      data,
    });
  }
}

function transpileTypeScript(code: string): string {
  const result = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });

  if (result.diagnostics && result.diagnostics.length > 0) {
    const diagnostics = result.diagnostics
      .map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"))
      .join("; ");
    throw new Error(`Failed to transpile TypeScript: ${diagnostics}`);
  }

  return result.outputText;
}

function normalizeDiscoverInput(payload: unknown): EnvironmentDiscoverInput {
  if (!payload || typeof payload !== "object") {
    throw new Error("Discover input must be an object.");
  }

  const candidate = payload as { query?: unknown; limit?: unknown };

  if (typeof candidate.query !== "string") {
    throw new Error("Field 'query' must be a string.");
  }

  const normalizedQuery = candidate.query.trim();
  if (normalizedQuery.length === 0) {
    throw new Error("Field 'query' must not be empty.");
  }

  if (candidate.limit === undefined) {
    return { query: normalizedQuery };
  }

  const limit = candidate.limit;

  if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
    throw new Error("Field 'limit' must be a positive integer.");
  }

  return {
    query: normalizedQuery,
    limit,
  };
}
