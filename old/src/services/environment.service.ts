import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

import ts from "typescript";

import type {
  ProcessMessage,
  ProcessMessageResponse,
} from "@/models/process";

export type ExecutionStatus = "success" | "failed" | "timeout" | "canceled";

export interface EnvironmentEvents {
  stdout: (chunk: Buffer) => void;
  stderr: (chunk: Buffer) => void;
  output: (data: unknown) => void;
  message: (
    message: ProcessMessage,
    respond: (response: ProcessMessageResponse) => void,
  ) => void;
}

export type Environment = EventEmitter & {
  execute(code: string): Promise<ExecutionStatus>;
  kill(): Promise<void>;
  on<U extends keyof EnvironmentEvents>(
    event: U,
    listener: EnvironmentEvents[U],
  ): Environment;
  once<U extends keyof EnvironmentEvents>(
    event: U,
    listener: EnvironmentEvents[U],
  ): Environment;
  emit<U extends keyof EnvironmentEvents>(
    event: U,
    ...args: Parameters<EnvironmentEvents[U]>
  ): boolean;
  off<U extends keyof EnvironmentEvents>(
    event: U,
    listener: EnvironmentEvents[U],
  ): Environment;
};

const MAX_STDOUT_BUFFER = 64 * 1024;

export const createEnvironment = (): Environment => {
  const emitter = new EventEmitter() as Environment;
  let child: ReturnType<typeof spawn> | null = null;

  const execute = async (code: string): Promise<ExecutionStatus> => {
    if (child) {
      return "failed";
    }

    let transpiled: string;
    try {
      transpiled = ts.transpileModule(code, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          strict: false,
          sourceMap: false,
        },
      }).outputText;
    } catch {
      return "failed";
    }

    return await new Promise<ExecutionStatus>((resolve) => {
      const spawned = spawn(process.execPath, ["-e", transpiled], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      child = spawned;
      let stdoutBuffer = Buffer.alloc(0);

      spawned.stdout.on("data", (chunk) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBuffer = Buffer.concat([stdoutBuffer, data]);
        if (stdoutBuffer.length > MAX_STDOUT_BUFFER) {
          stdoutBuffer = stdoutBuffer.subarray(
            stdoutBuffer.length - MAX_STDOUT_BUFFER,
          );
        }

        emitter.emit("stdout", data);
      });

      spawned.stderr.on("data", (chunk) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        emitter.emit("stderr", data);
      });

      spawned.on("close", (exitCode, signal) => {
        child = null;

        if (signal) {
          resolve("canceled");
          return;
        }

        if (exitCode === 0) {
          const text = stdoutBuffer.toString("utf8").trim();
          if (text.length === 0) {
            emitter.emit("output", null);
          } else {
            try {
              emitter.emit("output", JSON.parse(text));
            } catch {
              emitter.emit("output", text);
            }
          }

          resolve("success");
          return;
        }

        resolve("failed");
      });

      spawned.on("error", () => {
        child = null;
        resolve("failed");
      });
    });
  };

  const kill = async (): Promise<void> => {
    if (!child) {
      return;
    }

    child.kill("SIGTERM");
  };

  return Object.assign(emitter, { execute, kill });
};
