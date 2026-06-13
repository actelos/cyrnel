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
			const child = spawn("sh", ["-c", input.code], {
				timeout: input.options?.timeoutMs,
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
		return "# Shell Environment\n\nExecutes shell commands via `sh -c`.";
	}

	async generateToolDocs(input: ToolDocsInput) {
		return [
			`## ${input.description}`,
			"",
			"```sh",
			`${input.toolId} ${Object.keys(input.inputSchema).join(" ")}`,
			"```",
		].join("\n");
	}
}

export function instantiate(): EnvironmentModule {
	return new ShellEnvironment();
}
