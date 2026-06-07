import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { z } from "zod";
import { Pid, ProcessExitStateQuery, ProcessState } from "@/schemas";
import { api, searchParams } from "@/utils/fetch";

// biome-ignore lint/suspicious/noExplicitAny: tool params vary per entry
export const processTools: Tool<FastMCPSessionAuth, z.ZodType<any>>[] = [
  {
    name: "list_processes",
    description: `
    List stored processes using optional state/status/ref filters.

    Use this to browse existing processes or to find a pid to inspect with
    \`get_process\`, \`get_process_output\`, \`get_process_stdout\`, or
    \`get_process_stderr\`.

    When to use:
      - Use when you need to find processes by state/exit-state/ref.
    When NOT to use:
      - If you already know the pid, call \`get_process\` instead.

    Returns object with key \`processes\` (list of processes).
    Returns \`processes=[]\` when no matches.
    `,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      state: ProcessState.optional().describe(
        'Optional process state filter. Example: "idle".',
      ),
      status: ProcessExitStateQuery.optional().describe(
        'Optional process exit-state filter. Use "null" for running processes',
      ),
      ref: z
        .string()
        .min(1)
        .optional()
        .describe('Optional reference label filter. Example: "nightly-sync".'),
    }),
    execute: async ({ state, status, ref }) =>
      JSON.stringify(
        await api
          .get("processes", {
            searchParams: searchParams({ state, status, ref }),
          })
          .json(),
      ),
  },
  {
    name: "get_process",
    description: `
    Fetch a single process record by pid, returning its lifecycle metadata.

    When to use:
      - Use when you already have a pid and need its current state/exit-state.
    When NOT to use:
      - If you need stdout/stderr/code/output, use the specific getter tools
        instead.
    `,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({ pid: Pid }),
    execute: async ({ pid }) =>
      JSON.stringify(await api.get(`processes/${pid}`).json()),
  },
  {
    name: "create_process",
    description: `
    Create and run a new process from TypeScript code, returning its pid.

    A process encapsulates runnable code executed by the cyrnel environment module.
    If \`block\` is true, the API waits until the process returns to the
    \`idle\` state before responding.

    When to use:
      - Use to execute code that discovers services/tools or invokes them.
    When NOT to use:
      - If you want to re-run an existing idle process, use \`run_process\`
        instead.
    `,
    annotations: { idempotentHint: false, openWorldHint: true },
    parameters: z.object({
      code: z
        .string()
        .min(1)
        .describe("TypeScript source code to execute (plain text)."),
      ref: z
        .string()
        .min(1)
        .optional()
        .describe('Optional reference label. Example: "nightly-sync".'),
      timeout: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Optional execution timeout in seconds (positive integer)."),
      block: z
        .boolean()
        .default(true)
        .describe(
          "Whether to wait until the process becomes idle before returning.",
        ),
    }),
    execute: async ({ code, ref, timeout, block }) => {
      const body: Record<string, unknown> = { code, block };
      if (ref !== undefined) body.ref = ref;
      if (timeout !== undefined) body.options = { timeout: timeout * 1000 };
      return JSON.stringify(await api.post("processes", { json: body }).json());
    },
  },
  {
    name: "delete_process",
    description: `
    Delete an idle process by pid, returning the deleted process record.

    Deletion removes the stored record and its associated outputs. The API
    requires the process to be \`idle\` before it can be deleted.

    When to use:
      - Use to clean up completed/idle processes you no longer need.
    When NOT to use:
      - If the process is running or queued, call \`kill_process\` first, then
        delete.
    `,
    annotations: { destructiveHint: true, openWorldHint: true },
    parameters: z.object({ pid: Pid }),
    execute: async ({ pid }) =>
      JSON.stringify(await api.delete(`processes/${pid}`).json()),
  },
  {
    name: "get_process_code",
    description: `
    Fetch the original submitted source code for a process, returning raw text.

    When to use:
      - Use to inspect what code was submitted to \`create_process\`.
    When NOT to use:
      - If you need runtime output, use \`get_process_stdout\`,
        \`get_process_stderr\`, or \`get_process_output\`.
    `,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({ pid: Pid }),
    execute: async ({ pid }) => api.get(`processes/${pid}/code`).text(),
  },
  {
    name: "get_process_output",
    description: `
    Fetch the structured output object emitted by a process, returning JSON.

    This is distinct from stdout/stderr: it is structured data explicitly
    emitted by the process code. The API requires the process to be \`idle\`
    before output is available.

    When to use:
      - Use to read machine-readable results produced by a process.
    When NOT to use:
      - If you need text logs, use \`get_process_stdout\` /
        \`get_process_stderr\`.
    `,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({ pid: Pid }),
    execute: async ({ pid }) =>
      JSON.stringify(await api.get(`processes/${pid}/output`).json()),
  },
  {
    name: "get_process_stdout",
    description: `
    Fetch the captured stdout for an idle process, returning raw text.

    When to use:
      - Use to read standard output produced by the process execution.
    When NOT to use:
      - If you need structured data, use \`get_process_output\`.
    `,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({ pid: Pid }),
    execute: async ({ pid }) => api.get(`processes/${pid}/stdout`).text(),
  },
  {
    name: "get_process_stderr",
    description: `
    Fetch the captured stderr for an idle process, returning raw text.

    When to use:
      - Use to read standard error produced by the process execution.
    When NOT to use:
      - If you need structured data, use \`get_process_output\`.
    `,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({ pid: Pid }),
    execute: async ({ pid }) => api.get(`processes/${pid}/stderr`).text(),
  },
  {
    name: "run_process",
    description: `
    Run (or re-run) an idle process by pid, returning the resulting process
    record.

    The API only accepts a run signal when the process is currently \`idle\`.
    If \`force\` is false and the process has existing outputs, the API rejects
    the request.

    When to use:
      - Use to re-run a process you previously created.
    When NOT to use:
      - If you need to start a brand-new execution, use \`create_process\`.
    `,
    annotations: { idempotentHint: false, openWorldHint: true },
    parameters: z.object({
      pid: Pid,
      force: z
        .boolean()
        .default(false)
        .describe("Whether to overwrite existing outputs before rerunning."),
      block: z
        .boolean()
        .default(true)
        .describe("Whether to wait until the process becomes idle."),
    }),
    execute: async ({ pid, force, block }) =>
      JSON.stringify(
        await api
          .post(`processes/${pid}/signals/run`, { json: { force, block } })
          .json(),
      ),
  },
  {
    name: "kill_process",
    description: `
    Stop a queued or running process by pid, returning the updated process
    record.

    When to use:
      - Use to cancel queued work or interrupt a running process.
    When NOT to use:
      - If the process is already idle and you want to remove it, use
        \`delete_process\` instead.
    `,
    annotations: { idempotentHint: false, openWorldHint: true },
    parameters: z.object({ pid: Pid }),
    execute: async ({ pid }) =>
      JSON.stringify(
        await api.post(`processes/${pid}/signals/kill`, { json: {} }).json(),
      ),
  },
];
