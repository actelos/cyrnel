import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { Worker } from "node:worker_threads";
import ts from "typescript";

import type { ProcessStatus } from "@/models/process.model";

export type ExecutionStatus = Extract<ProcessStatus, "success" | "failed">;

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

type WorkerMessage =
  | WorkerOutputMessage
  | WorkerResultMessage
  | WorkerFailureMessage;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

export class EnvironmentModule extends EventEmitter {
  private killed = false;
  private worker: Worker | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  async execute(
    code: string,
    { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
  ): Promise<ExecutionStatus> {
    if (this.worker) {
      throw new Error("Execution already in progress");
    }

    this.killed = false;

    const transpiled = transpileTypeScript(code);
    const worker = this.createWorker(transpiled);

    this.worker = worker;

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
        await worker.terminate();
        pendingStatus = "failed";

        this.emit(
          "stderr",
          Buffer.from(`Execution timed out after ${timeoutMs}ms`),
        );

        settleResolved("failed");
      }, timeoutMs);

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

  private createWorker(transpiledCode: string): Worker {
    return new Worker(
      `
        const { parentPort, workerData } = require("node:worker_threads");
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
        const runUserCode = async () => {
          const runner = new Function("emitOutput", '"use strict"; return (async () => {\\n' + workerData.code + '\\n})();');
          return runner(emitOutput);
        };
        runUserCode()
          .then((result) => parentPort.postMessage({ type: "result", data: result }))
          .catch((error) => {
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
        workerData: { code: transpiledCode },
      },
    );
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
