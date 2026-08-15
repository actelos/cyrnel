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
  private logger: EnvironmentSetupContext["logger"] | null = null;
  private config: Record<string, unknown> = {};

  async setup({ bindings, config, logger }: EnvironmentSetupContext) {
    this.bindings = bindings;
    this.config = config;
    const patterns =
      (this.config.redactionPatterns as string[] | undefined) ?? [];
    this.logger = logger.redact(patterns).child({ phase: "setup" });
  }

  async teardown() {}

  async execute(input: ExecutionInput): Promise<ExecutionExitState> {
    const eid = input.eid;
    const execLogger = this.logger?.child({
      executionId: eid,
      phase: "execution",
    });
    execLogger?.info({ event: "execution-start" }, "Execution starting");

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
        execLogger?.info(
          { event: "execution-finished", exitCode: code },
          "Execution finished",
        );
        resolve(code === 0 ? "success" : "failed");
      });

      child.on("error", (err) => {
        this.bindings.setError(eid, err.message);
        execLogger?.error(
          { event: "execution-failed", err },
          "Execution failed",
        );
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
    const escapePlainText = (text: string) =>
      text.replace(/\s+/g, " ").replace(/[\\*_`[\]<>#]/g, "\\$&");
    return [
      summary ? `_${escapePlainText(summary)}_` : "",
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
    properties: {
      redactionPatterns: {
        type: "array",
        items: { type: "string" },
        description:
          "Path patterns (dot/bracket notation) merged additively with the host-enforced baseline for this module's logs.",
      },
    },
    additionalProperties: false,
  },
  secretsSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  instantiate: (): EnvironmentModule => new ShellEnvironment(),
};
