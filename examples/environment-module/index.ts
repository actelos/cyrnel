import { spawn } from "node:child_process";
import type {
  EnvironmentBindings,
  EnvironmentModule,
  EnvironmentSetupContext,
  ExecutionExitState,
  ExecutionInput,
  ToolDocsInput,
} from "@cyrnel/sdk";

class ShellEnvironment implements EnvironmentModule {
  private bindings!: EnvironmentBindings;

  async setup(_context: EnvironmentSetupContext) {}

  async teardown() {}

  async execute(input: ExecutionInput): Promise<ExecutionExitState> {
    const eid = input.eid;
    this.bindings.setState(eid, "running");

    return new Promise((resolve) => {
      const rawTimeoutMs = input.envConfig?.timeoutMs as number | undefined;
      const timeoutMs =
        Number.isInteger(rawTimeoutMs) && rawTimeoutMs >= 1
          ? rawTimeoutMs
          : 30_000;
      const child = spawn("sh", ["-c", input.code], {
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk: Buffer) => {
        this.bindings.emitStdout(eid, chunk);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        this.bindings.emitStderr(eid, chunk);
      });

      child.on("close", (code) => {
        this.bindings.emitOutput(eid, { exitCode: code });
        resolve(code === 0 ? "success" : "failed");
      });

      child.on("error", (err) => {
        this.bindings.setError(eid, err.message);
        resolve("failed");
      });
    });
  }

  async kill(_eid: number) {}

  async generateDocs() {
    return `# Shell Environment

Executes shell commands via \`sh -c\`.

## \`envConfig\`

| Key | Type | Default | Description |
| --- | --- | ------- | ----------- |
| \`timeoutMs\` | \`integer\` (>= 1) | 30000 | Process timeout in milliseconds. |`;
  }

  async generateToolDocs(input: ToolDocsInput) {
    const summary = input.summary?.trim();
    return [
      summary ? `_${summary}_` : "",
      `## ${input.description}`,
      "",
      "```sh",
      `${input.toolId} ${Object.keys(input.inputSchema).join(" ")}`,
      "```",
    ].join("\n");
  }
}

export default {
  configSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  secretsSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  instantiate: (): EnvironmentModule => new ShellEnvironment(),
};
