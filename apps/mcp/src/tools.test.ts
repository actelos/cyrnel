import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { HTTPError, type NormalizedOptions } from "ky";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { createApprovalPresenter } from "@/approval-presenter.js";
import { api } from "@/fetch.js";
import buildTools from "@/tools.js";

const decideApproval = vi.hoisted(() => vi.fn());
const getApproval = vi.hoisted(() => vi.fn());
const listApprovals = vi.hoisted(() => vi.fn());

vi.mock("@/approvals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/approvals.js")>();
  return { ...actual, decideApproval, getApproval, listApprovals };
});

vi.mock("@/fetch.js", () => ({
  api: { get: vi.fn(), post: vi.fn() },
  searchParams: (params: Record<string, unknown>) => params,
}));

const mockedGet = vi.mocked(api.get);

// biome-ignore lint/suspicious/noExplicitAny: test helper for the fastmcp Tool shape
type AnyTool = Tool<FastMCPSessionAuth, z.ZodType<any>>;

function toolsFor(method: "elicitation" | "manual"): AnyTool[] {
  return buildTools(createApprovalPresenter(method));
}

function findTool(method: "elicitation" | "manual", name: string): AnyTool {
  const tool = toolsFor(method).find((t) => t.name === name);
  if (!tool) throw new Error(`tool '${name}' is not registered`);
  return tool;
}

async function run(tool: AnyTool, args: unknown): Promise<string> {
  const result = await tool.execute(args as never, {} as never);
  return typeof result === "string" ? result : JSON.stringify(result);
}

/** Runs a tool through the zod schema fastmcp validates arguments with. */
async function runValidated(tool: AnyTool, args: unknown): Promise<string> {
  return run(tool, (tool.parameters as unknown as z.ZodType).parse(args));
}

/**
 * Routes `api.get` by url: `.../docs` paths read from `docs`, `GET tools`
 * reads from `pages` keyed by the search query (default page when absent).
 */
function stubGet(handlers: {
  page?: unknown;
  pages?: Record<string, unknown>;
  docs?: Record<string, string>;
}) {
  mockedGet.mockImplementation(((
    url: string,
    options?: { searchParams?: unknown },
  ) => {
    const docsMatch = /^tools\/([^/]+)\/([^/]+)\/docs$/.exec(url);
    if (docsMatch) {
      const key = `${decodeURIComponent(docsMatch[1])}.${decodeURIComponent(docsMatch[2])}`;
      const text = handlers.docs?.[key];
      if (text === undefined) throw notFound(`http://localhost/${url}`);
      return { text: async () => text };
    }
    const query = (options?.searchParams as { query?: string } | undefined)
      ?.query;
    return {
      json: async () =>
        query !== undefined && handlers.pages !== undefined
          ? (handlers.pages[query] ?? {
              items: [],
              nextCursor: null,
              hasMore: false,
            })
          : handlers.page,
    };
  }) as never);
}

/** The searchParams of every `GET tools` call made so far. */
function listSearchParams(): Array<Record<string, unknown>> {
  return mockedGet.mock.calls
    .filter(([url]) => url === "tools")
    .map(([, options]) => options?.searchParams as Record<string, unknown>);
}

function approvalStub(overrides: Record<string, unknown> = {}) {
  return {
    id: "apr_1",
    serviceId: "github",
    toolId: "createIssue",
    processId: 42,
    parameters: { title: "hello", apiToken: "leak-me" },
    state: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: 1_800_000_000_000,
    decidedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  decideApproval.mockReset();
  getApproval.mockReset();
  listApprovals.mockReset();
  mockedGet.mockReset();
  decideApproval.mockResolvedValue("decided");
});

/** ky 2 requires the normalized options snapshot that produced the error. */
function notFound(url: string) {
  return new HTTPError(new Response(null, { status: 404 }), new Request(url), {
    method: "GET",
    retry: {},
    prefix: "",
    context: {},
    onDownloadProgress: undefined,
    onUploadProgress: undefined,
  } satisfies NormalizedOptions);
}

describe("tool registration", () => {
  it("registers the approval tools only in manual mode", () => {
    const elicitationNames = toolsFor("elicitation").map((t) => t.name);
    const manualNames = toolsFor("manual").map((t) => t.name);

    expect(elicitationNames).not.toContain("list_pending_approvals");
    expect(elicitationNames).not.toContain("approve_approval");
    expect(elicitationNames).not.toContain("deny_approval");

    expect(manualNames).toContain("list_pending_approvals");
    expect(manualNames).toContain("approve_approval");
    expect(manualNames).toContain("deny_approval");
  });

  it("always registers the core process tools", () => {
    for (const method of ["elicitation", "manual"] as const) {
      const names = toolsFor(method).map((t) => t.name);
      for (const core of [
        "get_environment_docs",
        "list_tools",
        "get_tool_docs",
        "create_process",
        "get_process_output",
        "get_process_stdout",
        "get_process_stderr",
        "run_process",
        "kill_process",
        "unload_process",
      ]) {
        expect(names).toContain(core);
      }
    }
  });
});

describe("list_tools", () => {
  it("defaults to at most 5 results and forwards filters", async () => {
    stubGet({ page: { items: [], nextCursor: null, hasMore: false } });

    await runValidated(findTool("elicitation", "list_tools"), {
      service_id: "github",
      query: "create an issue",
    });

    expect(mockedGet).toHaveBeenCalledWith("tools", {
      searchParams: {
        serviceId: "github",
        query: "create an issue",
        limit: 5,
        enabled: undefined,
        decision: undefined,
        cursor: undefined,
      },
    });
  });

  it("rejects a limit above the cap", async () => {
    stubGet({ page: { items: [] } });
    const tool = findTool("elicitation", "list_tools");

    expect(() =>
      (tool.parameters as unknown as z.ZodType).parse({ limit: 6 }),
    ).toThrow();
    await expect(runValidated(tool, { limit: 50 })).rejects.toThrow();
  });

  it("passes the cursor through unchanged", async () => {
    stubGet({ page: { items: [], nextCursor: "c2", hasMore: true } });

    const out = await runValidated(findTool("elicitation", "list_tools"), {
      cursor: "c1",
      limit: 1,
    });

    expect(mockedGet).toHaveBeenCalledWith(
      "tools",
      expect.objectContaining({
        searchParams: expect.objectContaining({ cursor: "c1" }),
      }),
    );
    expect(JSON.parse(out)).toMatchObject({ nextCursor: "c2", hasMore: true });
  });

  it("omits docs by default", async () => {
    stubGet({
      page: {
        items: [{ serviceId: "github", id: "issues_create" }],
        nextCursor: null,
      },
      docs: { "github.issues_create": "# doc" },
    });

    const out = await runValidated(findTool("elicitation", "list_tools"), {});
    const parsed = JSON.parse(out) as { items: Array<Record<string, unknown>> };

    expect(parsed.items[0]).toEqual({
      serviceId: "github",
      id: "issues_create",
    });
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it("inlines docs for every result when include_docs is set", async () => {
    stubGet({
      page: {
        items: [
          { serviceId: "github", id: "issues_create" },
          { serviceId: "github", id: "issues_list" },
        ],
        nextCursor: "c2",
        hasMore: true,
      },
      docs: {
        "github.issues_create": "# Tool: `github.issues_create`",
        "github.issues_list": "# Tool: `github.issues_list`",
      },
    });

    const out = await runValidated(findTool("elicitation", "list_tools"), {
      include_docs: true,
    });
    const parsed = JSON.parse(out) as {
      items: Array<Record<string, unknown>>;
      nextCursor: string;
    };

    expect(parsed.items[0].docs).toBe("# Tool: `github.issues_create`");
    expect(parsed.items[1].docs).toBe("# Tool: `github.issues_list`");
    expect(parsed.nextCursor).toBe("c2");
  });

  it("reports a docs failure per tool without failing the page", async () => {
    stubGet({
      page: {
        items: [
          { serviceId: "github", id: "issues_create" },
          { serviceId: "github", id: "ghost" },
        ],
        nextCursor: null,
      },
      docs: { "github.issues_create": "# doc" },
    });

    const out = await runValidated(findTool("elicitation", "list_tools"), {
      include_docs: true,
    });
    const parsed = JSON.parse(out) as { items: Array<Record<string, unknown>> };

    expect(parsed.items[0].docs).toBe("# doc");
    expect(parsed.items[1].docs).toBeUndefined();
    expect(parsed.items[1].docs_error).toContain("github.ghost");
  });

  it("skips malformed rows instead of failing the page", async () => {
    stubGet({
      page: { items: [{ serviceId: "github" }, { id: "x" }], nextCursor: null },
    });

    const out = await runValidated(findTool("elicitation", "list_tools"), {
      include_docs: true,
    });

    expect(JSON.parse(out).items).toEqual([]);
  });

  it("runs each query of a batch and caps every one at 5 results", async () => {
    stubGet({
      pages: {
        "create an issue": {
          items: Array.from({ length: 5 }, (_, i) => ({
            serviceId: "github",
            id: `issues_create_${i}`,
          })),
          nextCursor: null,
          hasMore: false,
        },
        "post a chat message": {
          items: Array.from({ length: 5 }, (_, i) => ({
            serviceId: "slack",
            id: `chat_post_${i}`,
          })),
          nextCursor: "c2",
          hasMore: true,
        },
      },
    });

    const out = await runValidated(findTool("elicitation", "list_tools"), {
      queries: [{ query: "create an issue" }, { query: "post a chat message" }],
    });
    const groups = JSON.parse(out) as Array<{
      query: string;
      limit: number;
      items: unknown[];
      nextCursor: string | null;
      hasMore: boolean;
    }>;

    expect(listSearchParams()).toHaveLength(2);
    expect(groups).toHaveLength(2);
    expect(groups[0].items).toHaveLength(5);
    expect(groups[1].items).toHaveLength(5);
    expect(groups[0]).toMatchObject({ query: "create an issue", limit: 5 });
    expect(groups[1]).toMatchObject({
      query: "post a chat message",
      nextCursor: "c2",
      hasMore: true,
    });
  });

  it("lets a batch entry override the shared filters", async () => {
    stubGet({ page: { items: [], nextCursor: null } });

    await runValidated(findTool("elicitation", "list_tools"), {
      enabled: true,
      decision: "allow",
      queries: [
        { query: "a", service_id: "github", limit: 2, cursor: "c9" },
        { query: "b", decision: "block" },
      ],
    });

    expect(listSearchParams()).toEqual([
      {
        serviceId: "github",
        query: "a",
        limit: 2,
        enabled: true,
        decision: "allow",
        cursor: "c9",
      },
      {
        serviceId: undefined,
        query: "b",
        limit: 5,
        enabled: true,
        decision: "block",
        cursor: undefined,
      },
    ]);
  });

  it("inlines docs across every group of a batch", async () => {
    stubGet({
      pages: {
        a: {
          items: [{ serviceId: "github", id: "issues_create" }],
          nextCursor: null,
        },
        b: {
          items: [{ serviceId: "slack", id: "chat_post" }],
          nextCursor: null,
        },
      },
      docs: {
        "github.issues_create": "# Tool: `github.issues_create`",
        "slack.chat_post": "# Tool: `slack.chat_post`",
      },
    });

    const out = await runValidated(findTool("elicitation", "list_tools"), {
      queries: [{ query: "a" }, { query: "b" }],
      include_docs: true,
    });
    const groups = JSON.parse(out) as Array<{
      query: string;
      items: Array<Record<string, unknown>>;
    }>;

    expect(groups[0].items[0].docs).toBe("# Tool: `github.issues_create`");
    expect(groups[1].items[0].docs).toBe("# Tool: `slack.chat_post`");
  });

  it("rejects mixing batch and single mode", async () => {
    stubGet({ page: { items: [] } });
    const tool = findTool("elicitation", "list_tools");

    for (const args of [
      { queries: [{ query: "a" }], query: "b" },
      { queries: [{ query: "a" }], service_id: "github" },
      { queries: [{ query: "a" }], cursor: "c1" },
    ]) {
      await expect(runValidated(tool, args)).rejects.toThrow(/not both/);
    }
  });

  it("caps the number of queries and each per-query limit", () => {
    const parse = (args: unknown) =>
      (
        findTool("elicitation", "list_tools").parameters as unknown as z.ZodType
      ).parse(args);

    expect(() =>
      parse({
        queries: Array.from({ length: 11 }, (_, i) => ({ query: `q${i}` })),
      }),
    ).toThrow();
    expect(() => parse({ queries: [{ query: "a", limit: 6 }] })).toThrow();
    expect(() => parse({ queries: [] })).toThrow();
  });
});

describe("get_tool_docs", () => {
  it("returns raw markdown for a single tool", async () => {
    stubGet({
      docs: { "github.issues_create": "# Tool: `github.issues_create`" },
    });

    const out = await runValidated(findTool("elicitation", "get_tool_docs"), {
      service_id: "github",
      tool_id: "issues_create",
    });

    expect(out).toBe("# Tool: `github.issues_create`");
    expect(mockedGet).toHaveBeenCalledWith("tools/github/issues_create/docs");
  });

  it("returns docs for a list of tools in one call, in order", async () => {
    stubGet({
      docs: {
        "github.issues_create": "# Tool: `github.issues_create`",
        "slack.chat_post": "# Tool: `slack.chat_post`",
      },
    });

    const out = await runValidated(findTool("elicitation", "get_tool_docs"), {
      tools: [
        { service_id: "github", tool_id: "issues_create" },
        { service_id: "slack", tool_id: "chat_post" },
      ],
    });

    expect(out).toBe(
      "# Tool: `github.issues_create`\n\n---\n\n# Tool: `slack.chat_post`",
    );
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it("encodes ids in the docs path", async () => {
    stubGet({ docs: { "gh.my service.my tool": "# doc" } });

    await runValidated(findTool("elicitation", "get_tool_docs"), {
      tools: [{ service_id: "gh.my service", tool_id: "my tool" }],
    });

    expect(mockedGet).toHaveBeenCalledWith(
      "tools/gh.my%20service/my%20tool/docs",
    );
  });

  it("reports a missing tool inline so the rest of the batch survives", async () => {
    stubGet({
      docs: { "github.issues_create": "# Tool: `github.issues_create`" },
    });

    const out = await runValidated(findTool("elicitation", "get_tool_docs"), {
      tools: [
        { service_id: "github", tool_id: "issues_create" },
        { service_id: "github", tool_id: "ghost" },
      ],
    });

    expect(out).toContain("# Tool: `github.issues_create`");
    expect(out).toContain("## Tool: `github.ghost`");
    expect(out).toContain("_Docs unavailable:");
  });

  it("propagates the error in single-tool mode", async () => {
    stubGet({ docs: {} });

    await expect(
      runValidated(findTool("elicitation", "get_tool_docs"), {
        service_id: "github",
        tool_id: "ghost",
      }),
    ).rejects.toBeInstanceOf(HTTPError);
  });

  it("rejects ambiguous or incomplete arguments", async () => {
    stubGet({ docs: { "github.issues_create": "# doc" } });
    const tool = findTool("elicitation", "get_tool_docs");

    await expect(runValidated(tool, {})).rejects.toThrow(
      /Provide a `tools` array/,
    );
    await expect(runValidated(tool, { service_id: "github" })).rejects.toThrow(
      /Provide a `tools` array/,
    );
    await expect(
      runValidated(tool, {
        service_id: "github",
        tool_id: "issues_create",
        tools: [{ service_id: "github", tool_id: "issues_create" }],
      }),
    ).rejects.toThrow(/not both/);
  });

  it("caps the batch size", async () => {
    stubGet({ docs: {} });
    const tools = Array.from({ length: 11 }, (_, i) => ({
      service_id: "github",
      tool_id: `t${i}`,
    }));

    expect(() =>
      (
        findTool("elicitation", "get_tool_docs")
          .parameters as unknown as z.ZodType
      ).parse({ tools }),
    ).toThrow();
  });
});

describe("list_pending_approvals", () => {
  it("returns summarized approvals without leaking secrets", async () => {
    listApprovals.mockResolvedValue({
      items: [approvalStub()],
      nextCursor: null,
      hasMore: false,
    });

    const out = await run(findTool("manual", "list_pending_approvals"), {
      process_id: 42,
    });
    const parsed = JSON.parse(out) as {
      items: Array<Record<string, unknown>>;
    };

    expect(listApprovals).toHaveBeenCalledWith(
      expect.objectContaining({ state: "pending", processId: 42 }),
    );
    expect(parsed.items[0]).toMatchObject({
      id: "apr_1",
      service_id: "github",
      tool_id: "createIssue",
      process_id: 42,
      state: "pending",
    });
    expect(out).not.toContain("leak-me");
    expect(parsed.items[0].parameters_summary).toContain("***REDACTED***");
  });

  it("forwards pagination", async () => {
    listApprovals.mockResolvedValue({
      items: [],
      nextCursor: "c2",
      hasMore: true,
    });

    const out = await run(findTool("manual", "list_pending_approvals"), {
      limit: 5,
      cursor: "c1",
    });
    expect(listApprovals).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, cursor: "c1" }),
    );
    expect(JSON.parse(out)).toMatchObject({ nextCursor: "c2", hasMore: true });
  });
});

describe("approve_approval", () => {
  it("approves a pending approval", async () => {
    getApproval.mockResolvedValue(approvalStub());
    const out = await run(findTool("manual", "approve_approval"), {
      id: "apr_1",
    });

    expect(decideApproval).toHaveBeenCalledWith("apr_1", "approve");
    expect(JSON.parse(out)).toMatchObject({ outcome: "decided" });
  });

  it("does not re-decide an already decided approval", async () => {
    getApproval.mockResolvedValue(approvalStub({ state: "approved" }));
    const out = await run(findTool("manual", "approve_approval"), {
      id: "apr_1",
    });

    expect(decideApproval).not.toHaveBeenCalled();
    expect(JSON.parse(out)).toMatchObject({ outcome: "already-decided" });
  });

  it("rejects an approval belonging to another process", async () => {
    getApproval.mockResolvedValue(approvalStub({ processId: 7 }));
    await expect(
      run(findTool("manual", "approve_approval"), {
        id: "apr_1",
        process_id: 42,
      }),
    ).rejects.toThrow(/belongs to process 7, not 42/);
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("accepts a matching process id", async () => {
    getApproval.mockResolvedValue(approvalStub());
    await run(findTool("manual", "approve_approval"), {
      id: "apr_1",
      process_id: 42,
    });
    expect(decideApproval).toHaveBeenCalledWith("apr_1", "approve");
  });

  it("propagates a missing approval", async () => {
    getApproval.mockRejectedValue(
      notFound("http://localhost/approvals/apr_missing"),
    );
    await expect(
      run(findTool("manual", "approve_approval"), { id: "apr_missing" }),
    ).rejects.toBeInstanceOf(HTTPError);
  });
});

describe("deny_approval", () => {
  it("denies a pending approval", async () => {
    getApproval.mockResolvedValue(approvalStub());
    const out = await run(findTool("manual", "deny_approval"), {
      id: "apr_1",
    });

    expect(decideApproval).toHaveBeenCalledWith("apr_1", "deny");
    expect(JSON.parse(out)).toMatchObject({ outcome: "decided" });
  });

  it("does not re-decide an already decided approval", async () => {
    getApproval.mockResolvedValue(approvalStub({ state: "denied" }));
    await run(findTool("manual", "deny_approval"), { id: "apr_1" });
    expect(decideApproval).not.toHaveBeenCalled();
  });
});
