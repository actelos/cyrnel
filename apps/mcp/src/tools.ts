import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { z } from "zod";
import { api, searchParams } from "@/fetch.js";
import { ProcessId, type ProcessState, ServiceId, ToolId } from "@/schemas.js";

// biome-ignore lint/suspicious/noExplicitAny: fastmcp Tool generic requires schema type
const tools: Tool<FastMCPSessionAuth, z.ZodType<any>>[] = [
  {
    name: "get_environment_docs",
    description: `
    Returns the markdown reference for the currently active execution
    environment. Describes the runtime language, available globals (e.g. the
    \`cyrnel\` object for discovering and invoking services and tools), I/O
    conventions, and an example program. Read this before authoring process
    code.
    `
      .replace(/\s+/g, " ")
      .trim(),
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({}),
    execute: async () => api.get("environment/docs").text(),
  },
  {
    name: "list_tools",
    description: `
    List and filter tools across services. Use to find candidate tools
    across one or all services. If you know the tool and service id, use
    \`get_tool_docs\` for detailed parameter information.
    `
      .replace(/\s+/g, " ")
      .trim(),
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      service_id: z
        .string()
        .min(1)
        .optional()
        .describe('Optional service id filter. Example: "github".'),
      query: z
        .string()
        .optional()
        .describe('Optional search string. Example: "issues".'),
      limit: z
        .number()
        .int()
        .min(1)
        .default(10)
        .optional()
        .describe("Optional maximum number of results to return. Example: 10."),
      enabled: z.boolean().optional().describe("Optional enabled filter."),
    }),
    execute: async ({ service_id, query, limit, enabled }) =>
      JSON.stringify(
        await api
          .get("tools", {
            searchParams: searchParams({
              serviceId: service_id,
              query,
              limit,
              enabled,
            }),
          })
          .json(),
      ),
  },
  {
    name: "get_tool_docs",
    description: `
    Returns markdown docs for a single tool, Includes the tool's description,
    parameter list (with types and required flags), return shape, and a worked
    example in the environment's calling syntax. Read this before constructing
    a call to the tool so the parameters match the schema.
    `
      .replace(/\s+/g, " ")
      .trim(),
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      service_id: ServiceId,
      tool_id: ToolId,
    }),
    execute: async ({ service_id, tool_id }) =>
      api
        .get(
          `tools/${encodeURIComponent(service_id)}/${encodeURIComponent(tool_id)}/docs`,
        )
        .text(),
  },
  {
    name: "create_process",
    description: `
    Create a new process for execution. A process encapsulates runnable code
    executed by the cyrnel environment. Use to execute code that discovers
    services/tools or invokes tools etc. If you want to re-run an existing idle
    process, use \`run_process\` instead.
    `
      .replace(/\s+/g, " ")
      .trim(),
    annotations: { idempotentHint: false, openWorldHint: true },
    parameters: z.object({
      code: z
        .string()
        .min(1)
        .max(100 * 1024)
        .describe("Source code to execute."),
      ref: z
        .string()
        .min(1)
        .optional()
        .describe('Optional reference label. Example: "nightly-sync".'),
      env_config: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Per-execution environment configuration (see environment docs).",
        ),
      timeout: z
        .number()
        .int()
        .min(1)
        .default(30)
        .optional()
        .describe(
          "Execution timeout in seconds (defaults to 30). Maps to timeout_ms on the API.",
        ),
      autorun: z
        .boolean()
        .default(true)
        .describe(
          "Whether to start the process immediately. When false, the process is created in idle state and must be started via run_process.",
        ),
      block: z
        .boolean()
        .default(true)
        .describe(
          `
          Whether to wait until the process becomes idle before responding. If
          true, response will include selected outputs (stdout, stderr, output).
          `
            .replace(/\s+/g, " ")
            .trim(),
        ),
      with_output: z
        .boolean()
        .default(true)
        .describe("Include structured output when blocking."),
      with_stdout: z
        .boolean()
        .default(false)
        .describe("Include stdout when blocking. Enable for debugging."),
      with_stderr: z
        .boolean()
        .default(false)
        .describe("Include stderr when blocking. Enable for debugging."),
    }),
    execute: async ({
      code,
      ref,
      env_config,
      timeout,
      autorun,
      block,
      with_output,
      with_stdout,
      with_stderr,
    }) => {
      const body: Record<string, unknown> = { code };
      if (ref !== undefined) body.ref = ref;
      if (timeout !== undefined) body.timeout_ms = timeout * 1000;
      if (env_config !== undefined) body.envConfig = env_config;
      body.autorun = autorun;
      const { id } = (await api.post("processes", { json: body }).json()) as {
        id: number;
      };
      if (!block || !autorun) return JSON.stringify({ id });
      const process = await pollUntilIdle(id, timeout);
      const result: Record<string, unknown> = { ...process };
      if (with_output) {
        result.output = await api
          .get(`processes/${id}/output`)
          .json()
          .catch(() => ({}));
      }
      if (with_stdout) {
        result.stdout = await api
          .get(`processes/${id}/stdout`)
          .text()
          .catch(() => "");
      }
      if (with_stderr) {
        result.stderr = await api
          .get(`processes/${id}/stderr`)
          .text()
          .catch(() => "");
      }
      return JSON.stringify(result);
    },
  },
  {
    name: "get_process_output",
    description: `
    Fetch the structured JSON output object emitted by a process. Use to read
    results produced by a process code. If you need text logs, use
    \`get_process_stdout\` or \`get_process_stderr\`.
    `
      .replace(/\s+/g, " ")
      .trim(),
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({ id: ProcessId }),
    execute: async ({ id }) =>
      JSON.stringify(await api.get(`processes/${id}/output`).json()),
  },
  {
    name: "get_process_stdout",
    description: `
    Fetch the captured raw text stdout for a process. Use to read standard
    output produced by the process execution. If you need structured data, use
    \`get_process_output\`.
    `
      .replace(/\s+/g, " ")
      .trim(),
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({ id: ProcessId }),
    execute: async ({ id }) => api.get(`processes/${id}/stdout`).text(),
  },
  {
    name: "get_process_stderr",
    description: `
    Fetch the captured raw text stderr for a process. Use to read standard
    error produced by the process execution. If you need structured data, use
    \`get_process_output\`.
    `
      .replace(/\s+/g, " ")
      .trim(),
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({ id: ProcessId }),
    execute: async ({ id }) => api.get(`processes/${id}/stderr`).text(),
  },
  {
    name: "run_process",
    description: `
    Run or re-run an idle process by id. Only accepts a run signal when the
    process is currently \`idle\`. If \`force\` is false and the process has
    existing outputs, the request is rejected. Use to re-run a process you
    previously created.
    `
      .replace(/\s+/g, " ")
      .trim(),
    annotations: { idempotentHint: false, openWorldHint: true },
    parameters: z.object({
      id: ProcessId,
      force: z
        .boolean()
        .default(false)
        .describe("Whether to overwrite existing outputs before rerunning."),
      block: z
        .boolean()
        .default(true)
        .describe(
          `
          Whether to wait until the process becomes idle before responding. If
          true, response will include selected outputs (stdout, stderr, output).
          `
            .replace(/\s+/g, " ")
            .trim(),
        ),
      with_output: z
        .boolean()
        .default(true)
        .describe("Include structured output when blocking."),
      with_stdout: z
        .boolean()
        .default(false)
        .describe("Include stdout when blocking. Enable for debugging."),
      with_stderr: z
        .boolean()
        .default(false)
        .describe("Include stderr when blocking. Enable for debugging."),
    }),
    execute: async ({
      id,
      force,
      block,
      with_output,
      with_stdout,
      with_stderr,
    }) => {
      const process = (await api
        .post(`processes/${id}/signals/run`, { json: { force } })
        .json()) as Record<string, unknown>;
      if (!block) return JSON.stringify(process);
      const idleProcess = await pollUntilIdle(id);
      const result: Record<string, unknown> = { ...idleProcess };
      if (with_output) {
        result.output = await api
          .get(`processes/${id}/output`)
          .json()
          .catch(() => ({}));
      }
      if (with_stdout) {
        result.stdout = await api
          .get(`processes/${id}/stdout`)
          .text()
          .catch(() => "");
      }
      if (with_stderr) {
        result.stderr = await api
          .get(`processes/${id}/stderr`)
          .text()
          .catch(() => "");
      }
      return JSON.stringify(result);
    },
  },
  {
    name: "kill_process",
    description: `
    Stop a queued or running process by id, returning the updated process
    record. Use to cancel queued work or interrupt a running process.
    `,
    annotations: { idempotentHint: false, openWorldHint: true },
    parameters: z.object({ id: ProcessId }),
    execute: async ({ id }) =>
      JSON.stringify(
        await api.post(`processes/${id}/signals/kill`, { json: {} }).json(),
      ),
  },
];

async function pollUntilIdle(
  id: number,
  timeoutS?: number,
  pollIntervalMs = 100,
): Promise<Record<string, unknown>> {
  const timeoutMs = (timeoutS ?? 30) * 1000;
  const deadline = Date.now() + timeoutMs * 2 + 1_000;

  while (true) {
    const process = (await api.get(`processes/${id}`).json()) as {
      state: ProcessState;
    };
    if (process.state === "idle") return process;
    if (Date.now() >= deadline) {
      throw new Error(
        `Process ${id} did not become idle within the configured wait window.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export default tools;
