import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

class HostNodeModule extends EventEmitter {
  type = "environment";
  label = "javascript";
  #child = null;

  static MAX_STDOUT_BUFFER = 64 * 1024;

  async setup() {}

  async teardown() {
    await this.kill();
  }
  async execute(code) {
    if (this.#child) {
      return "failed";
    }

    return await new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", code], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.#child = child;
      let stdoutBuffer = Buffer.alloc(0);

      child.stdout.on("data", (chunk) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBuffer = Buffer.concat([stdoutBuffer, data]);
        if (stdoutBuffer.length > HostNodeModule.MAX_STDOUT_BUFFER) {
          stdoutBuffer = stdoutBuffer.subarray(
            stdoutBuffer.length - HostNodeModule.MAX_STDOUT_BUFFER,
          );
        }
        this.emit("stdout", Buffer.from(chunk));
      });

      child.stderr.on("data", (chunk) => {
        this.emit("stderr", Buffer.from(chunk));
      });

      child.on("close", (code, signal) => {
        this.#child = null;

        if (signal) {
          resolve("canceled");
          return;
        }

        if (code === 0) {
          const text = stdoutBuffer.toString("utf8").trim();
          if (text) {
            try {
              this.emit("output", JSON.parse(text));
            } catch {
              this.emit("output", text);
            }
          } else {
            this.emit("output", null);
          }

          resolve("success");
          return;
        }

        resolve("failed");
      });

      child.on("error", () => {
        this.#child = null;
        resolve("failed");
      });
    });
  }

  async kill() {
    if (!this.#child) return;
    this.#child.kill("SIGTERM");
  }
}

export default new HostNodeModule();
