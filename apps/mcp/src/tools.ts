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
    across one or all services using hybrid FTS5 and vector semantic search.
    Results are returned in relevance-ranked order. If you know the tool and
    service id, use \`get_tool_docs\` for detailed parameter information.
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
        .describe(
          'Optional natural-language capability-oriented search query. Natural-language phrases (e.g., "find tools for creating GitHub issues") are preferred over literal substring or keyword lookups. Results are returned in relevance-ranked order.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .default(10)
        .optional()
        .describe("Optional maximum number of results to return. Example: 10."),
      enabled: z.boolean().optional().describe("Optional enabled filter."),
      decision: z
        .enum(["allow", "block", "ask"])
        .optional()
        .describe("Optional policy decision filter."),
      cursor: z
        .string()
        .optional()
        .describe(
          "Opaque pagination token returned as nextCursor by a previous response. Pass it back unchanged to fetch the next page; omit to fetch the first page.",
        ),
    }),
    execute: async ({ service_id, query, limit, enabled, decision, cursor }) =>
      JSON.stringify(
        await api
          .get("tools", {
            searchParams: searchParams({
              serviceId: service_id,
              query,
              limit,
              enabled,
              decision,
              cursor,
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
      if (timeout !== undefined) body.timeoutMs = timeout * 1000;
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
  {
    name: "unload_process",
    description: `
    Remove an idle process from active memory, keeping its database record and
    outputs intact. The process id remains valid and can be revived later via
    \`run_process\`. Only accepts an unload signal for idle in-memory processes.
    `,
    annotations: { idempotentHint: false, openWorldHint: true },
    parameters: z.object({ id: ProcessId }),
    execute: async ({ id }) =>
      JSON.stringify(
        await api.post(`processes/${id}/signals/unload`, { json: {} }).json(),
      ),
  },
  {
    name: "list_approvals",
    description:
      "List approval requests, filterable by state (pending/approved/denied/expired), service, tool, or process. Paginated with before cursor.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    parameters: z.object({
      state: z.enum(["pending", "approved", "denied", "expired"]).optional(),
      service_id: z.string().optional(),
      tool_id: z.string().optional(),
      process_id: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
    }),
    execute: async ({
      state,
      service_id,
      tool_id,
      process_id,
      limit,
      cursor,
    }) =>
      JSON.stringify(
        await api
          .get("approvals", {
            searchParams: searchParams({
              state,
              serviceId: service_id,
              toolId: tool_id,
              processId: process_id,
              limit,
              cursor,
            }),
          })
          .json(),
      ),
  },
  {
    name: "get_approval",
    description:
      "Get a single approval request by id, including decrypted parameters.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    parameters: z.object({ id: z.string().min(1) }),
    execute: async ({ id }) =>
      JSON.stringify(
        await api.get(`approvals/${encodeURIComponent(id)}`).json(),
      ),
  },
  {
    name: "approve_approval",
    description:
      "Approve a pending approval request; the suspended invocation resumes and executes.",
    annotations: { idempotentHint: false },
    parameters: z.object({ id: z.string().min(1) }),
    execute: async ({ id }) =>
      JSON.stringify(
        await api
          .post(`approvals/${encodeURIComponent(id)}/approve`, { json: {} })
          .json(),
      ),
  },
  {
    name: "deny_approval",
    description:
      "Deny a pending approval request; the suspended invocation fails with a catchable error.",
    annotations: { idempotentHint: false },
    parameters: z.object({ id: z.string().min(1) }),
    execute: async ({ id }) =>
      JSON.stringify(
        await api
          .post(`approvals/${encodeURIComponent(id)}/deny`, { json: {} })
          .json(),
      ),
  },
  {
    name: "get_tool_policy",
    description:
      "Get the effective policy decision for a tool (allow/block/ask, default ask).",
    annotations: { readOnlyHint: true, idempotentHint: true },
    parameters: z.object({ service_id: ServiceId, tool_id: ToolId }),
    execute: async ({ service_id, tool_id }) =>
      JSON.stringify(
        await api
          .get(
            `tools/${encodeURIComponent(service_id)}/${encodeURIComponent(tool_id)}/policy`,
          )
          .json(),
      ),
  },
  {
    name: "set_tool_policy",
    description: "Set the policy decision for a tool to allow, block, or ask.",
    annotations: { idempotentHint: false },
    parameters: z.object({
      service_id: ServiceId,
      tool_id: ToolId,
      decision: z.enum(["allow", "block", "ask"]),
    }),
    execute: async ({ service_id, tool_id, decision }) =>
      JSON.stringify(
        await api
          .put(
            `tools/${encodeURIComponent(service_id)}/${encodeURIComponent(tool_id)}/policy`,
            { json: { decision } },
          )
          .json(),
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
  let attempt = 0;

  while (true) {
    const process = (await api.get(`processes/${id}`).json()) as {
      state: ProcessState;
      pendingApprovalIds?: string[];
    };
    if (
      process.state === "idle" ||
      process.state === "suspended" ||
      process.state === "terminating" ||
      process.state === "terminated"
    )
      return process;
    if (process.state === "queued" || process.state === "running") {
      // keep polling, but check deadline only for non-approval path
      if (Date.now() >= deadline) {
        throw new Error(
          `Process ${id} did not become idle within the configured wait window.`,
        );
      }
    } else if (Date.now() >= deadline) {
      throw new Error(
        `Process ${id} did not become idle within the configured wait window.`,
      );
    }
    attempt++;
    const delay = Math.min(pollIntervalMs * 1.5 ** (attempt - 1), 5000);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

export default tools;
