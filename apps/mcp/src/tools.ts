import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { z } from "zod";
import type { McpApprovalPresenter } from "@/approval-presenter.js";
import {
  decideApproval,
  getApproval,
  listApprovals,
  type PendingApproval,
  summarizeParameters,
} from "@/approvals.js";
import { api, searchParams } from "@/fetch.js";
import { waitForProcess } from "@/process.js";
import { ApprovalId, ProcessId, ServiceId, ToolId } from "@/schemas.js";

// biome-ignore lint/suspicious/noExplicitAny: fastmcp Tool generic requires schema type
type McpTools = Tool<FastMCPSessionAuth, z.ZodType<any>>[];

/**
 * Results-per-query for `list_tools`. This caps a single query's page, not the
 * whole response: batching `queries` multiplies it (10 queries x 5 = 50 tools).
 */
const LIST_TOOLS_MAX_LIMIT = 5;
/** How many queries one `list_tools` call may carry. */
const LIST_TOOLS_MAX_QUERIES = 10;
/** Hard cap on how many tool references one `get_tool_docs` call may carry. */
const TOOL_DOCS_MAX_BATCH = 10;

interface ToolRef {
  service_id: string;
  tool_id: string;
}

const ToolRefSchema = z.object({
  service_id: ServiceId,
  tool_id: ToolId,
});

type ListToolsQuery = z.infer<typeof ListToolsQuerySchema>;

/** One search within a `list_tools` batch. Every field overrides the top-level one. */
const ListToolsQuerySchema = z.object({
  query: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Natural-language capability-oriented search query for this search.",
    ),
  service_id: z
    .string()
    .min(1)
    .optional()
    .describe('Optional service id filter for this search. Example: "github".'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(LIST_TOOLS_MAX_LIMIT)
    .optional()
    .describe(
      `Results for this search, capped at ${LIST_TOOLS_MAX_LIMIT}. Defaults to the top-level \`limit\`.`,
    ),
  enabled: z.boolean().optional().describe("Optional enabled filter."),
  decision: z
    .enum(["allow", "block", "ask"])
    .optional()
    .describe("Optional effective policy decision filter."),
  cursor: z
    .string()
    .optional()
    .describe(
      "Opaque pagination token from a previous response for this search.",
    ),
});

/** A row of `GET /tools`, as far as this module cares. */
interface ListToolsItem extends Record<string, unknown> {
  serviceId: string;
  id: string;
}

function isListToolsItem(value: unknown): value is ListToolsItem {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ListToolsItem>;
  return (
    typeof candidate.serviceId === "string" && typeof candidate.id === "string"
  );
}

function docsPath(ref: ToolRef): string {
  return `tools/${encodeURIComponent(ref.service_id)}/${encodeURIComponent(ref.tool_id)}/docs`;
}

async function fetchToolDocs(ref: ToolRef): Promise<string> {
  return api.get(docsPath(ref)).text();
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Inlines docs into a listed tool, degrading to `docs_error` instead of throwing. */
async function withToolDocs(item: ListToolsItem): Promise<ListToolsItem> {
  const ref: ToolRef = { service_id: item.serviceId, tool_id: item.id };
  try {
    return { ...item, docs: await fetchToolDocs(ref) };
  } catch (err) {
    return {
      ...item,
      docs_error: `Docs unavailable for '${ref.service_id}.${ref.tool_id}': ${errorText(err)}`,
    };
  }
}

/** One `GET /tools` page. */
type ListToolsPage = Record<string, unknown>;

interface ListQuery {
  service_id?: string;
  query?: string;
  limit?: number;
  enabled?: boolean;
  decision?: "allow" | "block" | "ask";
  cursor?: string;
  include_docs?: boolean;
}

async function runListQuery(input: ListQuery): Promise<ListToolsPage> {
  const page = (await api
    .get("tools", {
      searchParams: searchParams({
        serviceId: input.service_id,
        query: input.query,
        limit: input.limit,
        enabled: input.enabled,
        decision: input.decision,
        cursor: input.cursor,
      }),
    })
    .json()) as ListToolsPage;
  if (!input.include_docs) return page;
  return {
    ...page,
    items: await Promise.all(listableItems(page).map(withToolDocs)),
  };
}

/** The usable rows of a page: anything missing `serviceId`/`id` is dropped. */
function listableItems(page: ListToolsPage): ListToolsItem[] {
  return Array.isArray(page.items)
    ? (page.items as unknown[]).filter(isListToolsItem)
    : [];
}

function baseTools(presenter: McpApprovalPresenter): McpTools {
  return [
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
    Find candidate tools across services using hybrid FTS5 and vector semantic
    search, in relevance-ranked order. Run one search with \`query\`, or pass
    \`queries\` to run up to ${LIST_TOOLS_MAX_QUERIES} independent searches in
    a single call and get one result group back per query. Each query returns
    at most ${LIST_TOOLS_MAX_LIMIT} tools, so narrow with \`query\` rather than
    expecting a large page. Set \`include_docs\` to inline the full parameter
    docs of every returned tool, so one call covers both discovery and
    invocation schemas. If you already know the tool and service id, use
    \`get_tool_docs\`, which also accepts a list of tools.
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
            'Optional natural-language capability-oriented search query for a single search. Natural-language phrases (e.g., "find tools for creating GitHub issues") are preferred over literal substring or keyword lookups. Results are returned in relevance-ranked order. Mutually exclusive with `queries`.',
          ),
        queries: z
          .array(ListToolsQuerySchema)
          .min(1)
          .max(LIST_TOOLS_MAX_QUERIES)
          .optional()
          .describe(
            `Batch mode: 1-${LIST_TOOLS_MAX_QUERIES} independent searches, each with its own \`query\`, \`service_id\`, \`limit\` (max ${LIST_TOOLS_MAX_LIMIT}) and \`cursor\`. The response carries one result group per query, in the same order. Use this instead of repeated single searches. Mutually exclusive with the top-level \`query\`/\`service_id\`/\`cursor\`.`,
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(LIST_TOOLS_MAX_LIMIT)
          .default(LIST_TOOLS_MAX_LIMIT)
          .describe(
            `Maximum number of results for a single search, capped at ${LIST_TOOLS_MAX_LIMIT} (default ${LIST_TOOLS_MAX_LIMIT}). Narrow with \`query\` rather than raising this.`,
          ),
        enabled: z.boolean().optional().describe("Optional enabled filter."),
        decision: z
          .enum(["allow", "block", "ask"])
          .optional()
          .describe(
            "Optional effective policy decision filter (resolved via ordered rules, immutable ask default).",
          ),
        include_docs: z
          .boolean()
          .default(false)
          .describe(
            "Inline the full markdown docs (parameters, return shape, example) of each returned tool, across every query in the response. Costs one extra API call per result but removes the follow-up `get_tool_docs` round trip. A tool whose docs cannot be fetched reports `docs_error` instead of failing the group.",
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            "Opaque pagination token returned as nextCursor by a previous response. Pass it back unchanged to fetch the next page; omit to fetch the first page.",
          ),
      }),
      execute: async ({
        service_id,
        query,
        queries,
        limit,
        enabled,
        decision,
        include_docs,
        cursor,
      }) => {
        if (queries !== undefined) {
          if (
            query !== undefined ||
            service_id !== undefined ||
            cursor !== undefined
          ) {
            throw new Error(
              "Pass either `queries` (batch mode) or top-level `query`/`service_id`/`cursor` (single mode), not both.",
            );
          }
          const groups = await Promise.all(
            queries.map(async (entry: ListToolsQuery) => {
              const entryLimit = entry.limit ?? limit;
              const page = await runListQuery({
                service_id: entry.service_id,
                query: entry.query,
                limit: entryLimit,
                enabled: entry.enabled ?? enabled,
                decision: entry.decision ?? decision,
                cursor: entry.cursor,
                include_docs,
              });
              // Echo the search back so an agent can pair each group with the
              // query that produced it.
              return {
                ...page,
                query: entry.query,
                service_id: entry.service_id,
                limit: entryLimit,
              };
            }),
          );
          return JSON.stringify(groups);
        }
        return JSON.stringify(
          await runListQuery({
            service_id,
            query,
            limit,
            enabled,
            decision,
            cursor,
            include_docs,
          }),
        );
      },
    },
    {
      name: "get_tool_docs",
      description: `
    Returns markdown docs for one or many tools, in a single call. Each doc
    includes the tool's description, parameter list (with types and required
    flags), return shape, and a worked example in the environment's calling
    syntax. Read this before constructing calls so parameters match the
    schema. Pass a single tool via \`service_id\` + \`tool_id\`, or up to
    ${TOOL_DOCS_MAX_BATCH} tools via \`tools\` to read every candidate in one
    query (for example the results of a \`list_tools\` call).
    `
        .replace(/\s+/g, " ")
        .trim(),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      parameters: z.object({
        service_id: ServiceId.optional().describe(
          "Single-tool mode: service id. Must be combined with `tool_id`.",
        ),
        tool_id: ToolId.optional().describe(
          "Single-tool mode: tool id. Must be combined with `service_id`.",
        ),
        tools: z
          .array(ToolRefSchema)
          .min(1)
          .max(TOOL_DOCS_MAX_BATCH)
          .optional()
          .describe(
            `Batch mode: 1-${TOOL_DOCS_MAX_BATCH} tool references to document at once. Mutually exclusive with \`service_id\`/\`tool_id\`. Docs are returned in the given order, each prefixed with \`# Tool: <service>.<tool>\`; a tool that cannot be documented is reported inline instead of failing the batch.`,
          ),
      }),
      execute: async ({ service_id, tool_id, tools }) => {
        if (tools !== undefined) {
          if (service_id !== undefined || tool_id !== undefined) {
            throw new Error(
              "Pass either `tools` (batch mode) or `service_id` + `tool_id` (single-tool mode), not both.",
            );
          }
          if (tools.length === 1) return fetchToolDocs(tools[0]);
          const docs = await Promise.all(
            tools.map(async (ref: ToolRef) => {
              try {
                return await fetchToolDocs(ref);
              } catch (err) {
                return `## Tool: \`${ref.service_id}.${ref.tool_id}\`\n\n_Docs unavailable: ${errorText(err)}_`;
              }
            }),
          );
          return docs.join("\n\n---\n\n");
        }
        if (service_id === undefined || tool_id === undefined) {
          throw new Error(
            "Provide a `tools` array of tool references, or both `service_id` and `tool_id`.",
          );
        }
        return fetchToolDocs({ service_id, tool_id });
      },
    },
    {
      name: "create_process",
      description: (() => {
        const inBand = presenter.inBand;
        const base = `
    Create a new process for execution. A process encapsulates runnable code
    executed by the cyrnel environment. Use to execute code that discovers
    services/tools or invokes tools etc. If you want to re-run an existing idle
    process, use \`run_process\` instead.
`;
        const approvalGuidance = inBand
          ? `
    A blocked call may return \`state: "suspended"\` with
    \`pendingApprovalIds\` because a tool call is awaiting a human decision.
    That is a normal result, not a failure: report the pending tool to the
    user and wait; do not retry the call and do not try to approve it.
`
          : `
    A blocked call returns \`state: "suspended"\` with
    \`pendingApprovalIds\`. Call \`list_pending_approvals\` to see what needs
    a decision, then use \`approve_approval\` or \`deny_approval\` to resolve
    each one. Do not retry the call while approvals are pending.
`;
        return (base + approvalGuidance).replace(/\s+/g, " ").trim();
      })(),
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
          .describe(
            "Optional correlation label. Unique only among live processes, so re-creating with a label a still-running process holds returns 409; prefer run_process with a process id to re-run.",
          ),
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
            (() => {
              const inBand = presenter.inBand;
              const base = `
          Whether to wait until the process completes (idle or terminated)
          before responding. If true, the response includes the selected
          outputs (stdout, stderr, output).
`;
              const approvalGuidance = inBand
                ? `
          Time spent awaiting approval is included but bounded: a pending
          approval that nobody answers within the per-prompt budget returns
          the process as \`state: "suspended"\` with \`pendingApprovalIds\`
          rather than waiting indefinitely. How approvals reach you depends
          on the server's configured MCP approval method: requested
          interactively, or returned as pending for a human to decide
          explicitly.
`
                : `
          A blocked call returns \`state: "suspended"\` with
          \`pendingApprovalIds\`. Call \`list_pending_approvals\` to see
          what needs a decision, then use \`approve_approval\` or
          \`deny_approval\` to resolve each one. Do not retry the call while
          approvals are pending.
`;
              return (base + approvalGuidance).replace(/\s+/g, " ").trim();
            })(),
          ),
        with_output: z
          .boolean()
          .default(true)
          .describe(
            "Include structured output when blocking. The process snapshot is always included, so output is present even when the process is suspended.",
          ),
        with_stdout: z
          .boolean()
          .default(false)
          .describe("Include stdout when blocking. Enable for debugging."),
        with_stderr: z
          .boolean()
          .default(false)
          .describe("Include stderr when blocking. Enable for debugging."),
      }),
      execute: async (
        {
          code,
          ref,
          env_config,
          timeout,
          autorun,
          block,
          with_output,
          with_stdout,
          with_stderr,
        },
        ctx,
      ) => {
        const body: Record<string, unknown> = { code };
        if (ref !== undefined) body.ref = ref;
        if (timeout !== undefined) body.timeoutMs = timeout * 1000;
        if (env_config !== undefined) body.envConfig = env_config;
        body.autorun = autorun;
        const { id } = (await api.post("processes", { json: body }).json()) as {
          id: number;
        };
        if (!block || !autorun) return JSON.stringify({ id });
        const process = await waitForProcess(id, {
          timeoutS: timeout,
          ctx,
          presenter,
        });
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
      description: (() => {
        const inBand = presenter.inBand;
        const base = `
    Run or re-run an idle process by id. Only accepts a run signal when the
    process is currently \`idle\`. If \`force\` is false and the process has
    existing outputs, the request is rejected. Use to re-run a process you
    previously created.
`;
        const approvalGuidance = inBand
          ? `
    Time spent awaiting approval is included but bounded: a pending approval
    that nobody answers within the per-prompt budget returns the process as
    \`state: "suspended"\` with \`pendingApprovalIds\` rather than waiting
    indefinitely. How approvals reach you depends on the server's configured
    MCP approval method: requested interactively, or returned as pending for a
    human to decide explicitly.
`
          : `
    A blocked call returns \`state: "suspended"\` with
    \`pendingApprovalIds\`. Call \`list_pending_approvals\` to see what needs
    a decision, then use \`approve_approval\` or \`deny_approval\` to resolve
    each one. Do not retry the call while approvals are pending.
`;
        return (base + approvalGuidance).replace(/\s+/g, " ").trim();
      })(),
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
            (() => {
              const inBand = presenter.inBand;
              const base = `
          Whether to wait until the process completes (idle or terminated)
          before responding. If true, the response includes the selected
          outputs (stdout, stderr, output).
`;
              const approvalGuidance = inBand
                ? `
          Time spent awaiting approval is included but bounded: a pending
          approval that nobody answers within the per-prompt budget returns
          the process as \`state: "suspended"\` with \`pendingApprovalIds\`
          rather than waiting indefinitely. How approvals reach you depends
          on the server's configured MCP approval method: requested
          interactively, or returned as pending for a human to decide
          explicitly.
`
                : `
          A blocked call returns \`state: "suspended"\` with
          \`pendingApprovalIds\`. Call \`list_pending_approvals\` to see
          what needs a decision, then use \`approve_approval\` or
          \`deny_approval\` to resolve each one. Do not retry the call while
          approvals are pending.
`;
              return (base + approvalGuidance).replace(/\s+/g, " ").trim();
            })(),
          ),
        with_output: z
          .boolean()
          .default(true)
          .describe(
            "Include structured output when blocking. The process snapshot is always included, so output is present even when the process is suspended.",
          ),
        with_stdout: z
          .boolean()
          .default(false)
          .describe("Include stdout when blocking. Enable for debugging."),
        with_stderr: z
          .boolean()
          .default(false)
          .describe("Include stderr when blocking. Enable for debugging."),
      }),
      execute: async (
        { id, force, block, with_output, with_stdout, with_stderr },
        ctx,
      ) => {
        const process = (await api
          .post(`processes/${id}/signals/run`, { json: { force } })
          .json()) as Record<string, unknown>;
        if (!block) return JSON.stringify(process);
        const idleProcess = await waitForProcess(id, { ctx, presenter });
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
  ];
}

function toApprovalSummary(approval: PendingApproval) {
  return {
    id: approval.id,
    service_id: approval.serviceId,
    tool_id: approval.toolId,
    process_id: approval.processId,
    state: approval.state,
    created_at: approval.createdAt,
    expires_at: approval.expiresAt,
    parameters_summary: summarizeParameters(approval.parameters),
  };
}

const manualApprovalTools: McpTools = [
  {
    name: "list_pending_approvals",
    description: `
    List tool invocations that are waiting for approval before they can run.
    A suspended process is blocked until each of its pending approvals is
    decided, so list them, inspect the summaries, then decide with
    \`approve_approval\` or \`deny_approval\` to let the process continue.
    `
      .replace(/\s+/g, " ")
      .trim(),
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      process_id: ProcessId.optional().describe(
        "Restrict to a single process. Omit to list pending approvals across all processes.",
      ),
      limit: z
        .number()
        .int()
        .min(1)
        .default(20)
        .optional()
        .describe("Maximum number of results to return."),
      cursor: z
        .string()
        .optional()
        .describe(
          "Opaque pagination token returned as nextCursor by a previous response. Pass it back unchanged to fetch the next page; omit to fetch the first page.",
        ),
    }),
    execute: async ({ process_id, limit, cursor }) => {
      const page = await listApprovals({
        state: "pending",
        processId: process_id,
        limit,
        cursor,
      });
      return JSON.stringify({
        items: page.items.map(toApprovalSummary),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      });
    },
  },
  {
    name: "approve_approval",
    description: `
    Approve a pending tool invocation so it runs and its process resumes.
    Use \`list_pending_approvals\` to find the approval id and review the
    summarized parameters before deciding.
    `
      .replace(/\s+/g, " ")
      .trim(),
    annotations: { idempotentHint: false, openWorldHint: true },
    parameters: z.object({
      id: ApprovalId,
      process_id: ProcessId.optional().describe(
        "Optional expected process id. When provided, the approval is rejected unless it belongs to this process.",
      ),
    }),
    execute: async ({ id, process_id }) => {
      const approval = await getApproval(id);
      if (approval.state !== "pending") {
        return JSON.stringify({
          ...toApprovalSummary(approval),
          outcome: "already-decided",
        });
      }
      if (process_id !== undefined && approval.processId !== process_id) {
        throw new Error(
          `Approval '${id}' belongs to process ${approval.processId ?? "unknown"}, not ${process_id}.`,
        );
      }
      const outcome = await decideApproval(id, "approve");
      return JSON.stringify({ ...toApprovalSummary(approval), outcome });
    },
  },
  {
    name: "deny_approval",
    description: `
    Deny a pending tool invocation. The tool call does not run and its process
    resumes with an error explaining that approval was denied. Use
    \`list_pending_approvals\` to find the approval id first.
    `
      .replace(/\s+/g, " ")
      .trim(),
    annotations: { idempotentHint: false, openWorldHint: true },
    parameters: z.object({
      id: ApprovalId,
      process_id: ProcessId.optional().describe(
        "Optional expected process id. When provided, the approval is rejected unless it belongs to this process.",
      ),
    }),
    execute: async ({ id, process_id }) => {
      const approval = await getApproval(id);
      if (approval.state !== "pending") {
        return JSON.stringify({
          ...toApprovalSummary(approval),
          outcome: "already-decided",
        });
      }
      if (process_id !== undefined && approval.processId !== process_id) {
        throw new Error(
          `Approval '${id}' belongs to process ${approval.processId ?? "unknown"}, not ${process_id}.`,
        );
      }
      const outcome = await decideApproval(id, "deny");
      return JSON.stringify({ ...toApprovalSummary(approval), outcome });
    },
  },
];

export default function buildTools(presenter: McpApprovalPresenter): McpTools {
  return presenter.inBand
    ? baseTools(presenter)
    : [...baseTools(presenter), ...manualApprovalTools];
}
