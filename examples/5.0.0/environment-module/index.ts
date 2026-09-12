import { spawn } from "node:child_process";
import type {
  ConfigProvider,
  EnvironmentBindings,
  EnvironmentModule,
  EnvironmentSetupContext,
  ExecutionExitState,
  ExecutionInput,
  ModuleLogger,
  ToolDocsInput,
} from "@cyrnel/sdk";

async function readOptionalConfig(
  provider: ConfigProvider<Record<string, unknown>>,
  key: string,
): Promise<unknown> {
  try {
    return await provider.get(key);
  } catch (err) {
    if (err instanceof Error && err.name === "ProviderKeyNotConfigured") {
      return undefined;
    }
    throw err;
  }
}

class ShellEnvironment implements EnvironmentModule {
  private bindings!: EnvironmentBindings;
  private logger: ModuleLogger | null = null;

  async setup({ bindings, config, logger }: EnvironmentSetupContext) {
    this.bindings = bindings;
    const rawPatterns = await readOptionalConfig(
      config as ConfigProvider<Record<string, unknown>>,
      "redactionPatterns",
    );
    const patterns = Array.isArray(rawPatterns)
      ? rawPatterns.filter((p): p is string => typeof p === "string")
      : [];
    this.logger = logger.redact(patterns).child({ phase: "setup" });
  }

  async teardown() {}

  async execute(
    input: ExecutionInput<{ timeoutMs?: number }>,
  ): Promise<ExecutionExitState> {
    const executionId = input.executionId;
    const execLogger = this.logger?.child({
      phase: "execution",
    });
    execLogger?.info({ event: "execution-start" }, "Execution starting");

    this.bindings.setState(executionId, "running");

    return new Promise((resolve) => {
      const rawTimeoutMs = input.envConfig?.timeoutMs;
      const timeoutMs = Number.isInteger(rawTimeoutMs) && rawTimeoutMs! >= 1 ? rawTimeoutMs! : 30_000;
      const child = spawn("sh", ["-c", input.code], {
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk: Buffer) => {
        this.bindings.emitStdout(executionId, chunk);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        this.bindings.emitStderr(executionId, chunk);
      });

      child.on("close", (code) => {
        this.bindings.emitOutput(executionId, { exitCode: code });
        execLogger?.info(
          { event: "execution-finished", exitCode: code },
          "Execution finished",
        );
        resolve(code === 0 ? "success" : "failed");
      });

      child.on("error", (err) => {
        this.bindings.setError(executionId, err.message);
        execLogger?.error(
          { event: "execution-failed", err },
          "Execution failed",
        );
        resolve("failed");
      });
    });
  }

  async kill(_executionId: number) {}

  async suspend(_executionId: number) {}

  async resume(_executionId: number) {}

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
  executionConfigSchema: {
    type: "object",
    properties: {
      timeoutMs: {
        type: "integer",
        default: 30000,
        minimum: 1,
        description: "Process timeout in milliseconds.",
      },
    },
    additionalProperties: false,
  },
  instantiate: (): EnvironmentModule => new ShellEnvironment(),
};