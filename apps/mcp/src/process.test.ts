import type { Context, FastMCPSessionAuth } from "fastmcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  McpApprovalPresenter,
  PresentInput,
} from "@/approval-presenter.js";
import { waitForProcess } from "@/process.js";

const listAllPendingApprovals = vi.hoisted(() => vi.fn());

vi.mock("@/approvals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/approvals.js")>();
  return { ...actual, listAllPendingApprovals };
});

vi.mock("@/fetch.js", () => ({
  api: { get: vi.fn() },
  searchParams: (params: Record<string, unknown>) => params,
}));

const { api } = await import("@/fetch.js");
const get = vi.mocked(api.get);

type State =
  | "idle"
  | "queued"
  | "running"
  | "suspended"
  | "terminating"
  | "terminated";

function respondWith(states: State[]) {
  let call = 0;
  get.mockImplementation(() => {
    const state = states[Math.min(call, states.length - 1)];
    call++;
    return { json: async () => ({ id: 42, state }) } as never;
  });
}

function approvalStub(id: string) {
  return {
    id,
    serviceId: "github",
    toolId: "createIssue",
    processId: 42,
    parameters: {},
    state: "pending",
    createdAt: null,
    expiresAt: null,
    decidedAt: null,
  };
}

function recordingPresenter(overrides: Partial<McpApprovalPresenter> = {}) {
  const present = vi.fn<(input: PresentInput) => Promise<void>>(async () => {});
  return {
    present,
    presenter: {
      method: "elicitation",
      inBand: true,
      present,
      ...overrides,
    } as McpApprovalPresenter,
  };
}

const ctx = {} as Context<FastMCPSessionAuth>;
const WAIT = { pollIntervalMs: 1 } as const;

beforeEach(() => {
  get.mockReset();
  listAllPendingApprovals.mockReset();
  listAllPendingApprovals.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("waitForProcess", () => {
  it("returns immediately when the process is idle", async () => {
    respondWith(["idle"]);
    const process = await waitForProcess(42, WAIT);
    expect(process.state).toBe("idle");
  });

  it("returns immediately when the process is terminated", async () => {
    respondWith(["terminated"]);
    const process = await waitForProcess(42, WAIT);
    expect(process.state).toBe("terminated");
  });

  it("polls through running states until idle", async () => {
    respondWith(["running", "running", "idle"]);
    const process = await waitForProcess(42, WAIT);
    expect(process.state).toBe("idle");
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("elicits approvals then continues to completion", async () => {
    respondWith(["suspended", "running", "idle"]);
    listAllPendingApprovals
      .mockResolvedValueOnce([approvalStub("apr_1")])
      .mockResolvedValue([]);

    const { present, presenter } = recordingPresenter();
    const process = await waitForProcess(42, { ...WAIT, ctx, presenter });

    expect(process.state).toBe("idle");
    expect(present).toHaveBeenCalledTimes(1);
    expect(present).toHaveBeenCalledWith({
      processId: 42,
      approvals: [approvalStub("apr_1")],
      ctx,
    });
  });

  it("repeats the cycle for sequential approvals", async () => {
    respondWith(["suspended", "suspended", "running", "idle"]);
    listAllPendingApprovals
      .mockResolvedValueOnce([approvalStub("apr_1")])
      .mockResolvedValueOnce([approvalStub("apr_2")])
      .mockResolvedValue([]);

    const { present, presenter } = recordingPresenter();
    const process = await waitForProcess(42, { ...WAIT, ctx, presenter });

    expect(process.state).toBe("idle");
    expect(present).toHaveBeenCalledTimes(2);
    expect(present.mock.calls[0][0].approvals[0].id).toBe("apr_1");
    expect(present.mock.calls[1][0].approvals[0].id).toBe("apr_2");
  });

  it("presents every simultaneously pending approval in one round", async () => {
    respondWith(["suspended", "idle"]);
    listAllPendingApprovals
      .mockResolvedValueOnce([
        approvalStub("apr_1"),
        approvalStub("apr_2"),
        approvalStub("apr_3"),
      ])
      .mockResolvedValue([]);

    const { present, presenter } = recordingPresenter();
    await waitForProcess(42, { ...WAIT, ctx, presenter });

    expect(present).toHaveBeenCalledTimes(1);
    expect(present.mock.calls[0][0].approvals).toHaveLength(3);
  });

  it("does not equate suspended with approval required", async () => {
    respondWith(["suspended", "suspended", "idle"]);
    listAllPendingApprovals.mockResolvedValue([]);

    const { present, presenter } = recordingPresenter();
    const process = await waitForProcess(42, { ...WAIT, ctx, presenter });

    expect(process.state).toBe("idle");
    expect(present).not.toHaveBeenCalled();
  });

  it("hands the suspended process back when no context is available", async () => {
    respondWith(["suspended"]);
    listAllPendingApprovals.mockResolvedValue([approvalStub("apr_1")]);

    const { present, presenter } = recordingPresenter();
    const process = await waitForProcess(42, { ...WAIT, presenter });

    expect(process.state).toBe("suspended");
    expect(present).not.toHaveBeenCalled();
  });

  it("hands the suspended process back for the manual presenter", async () => {
    respondWith(["suspended"]);
    listAllPendingApprovals.mockResolvedValue([approvalStub("apr_1")]);

    const { present, presenter } = recordingPresenter({
      method: "manual",
      inBand: false,
    });
    const process = await waitForProcess(42, { ...WAIT, ctx, presenter });

    expect(process.state).toBe("suspended");
    expect(present).not.toHaveBeenCalled();
  });

  it("stops polling at the suspended ceiling when nothing is pending", async () => {
    const base = Date.now();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(base)
      .mockReturnValue(base + 11 * 60_000);

    respondWith(["suspended"]);
    const process = await waitForProcess(42, WAIT);
    expect(process.state).toBe("suspended");
  });

  it("throws when a running process exceeds its wait window", async () => {
    const base = Date.now();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(base)
      .mockReturnValue(base + 10 * 60_000);

    respondWith(["running"]);
    await expect(waitForProcess(42, { ...WAIT, timeoutS: 30 })).rejects.toThrow(
      /did not become idle within the configured wait window/,
    );
  });

  it("excludes time spent eliciting from the run deadline", async () => {
    const base = Date.now();
    // 40s of wall clock passes, but 30s of it was spent asking the user.
    let now = base;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    respondWith(["suspended", "running", "idle"]);
    listAllPendingApprovals
      .mockResolvedValueOnce([approvalStub("apr_1")])
      .mockResolvedValue([]);

    const { presenter } = recordingPresenter({
      present: vi.fn(async () => {
        now = base + 30_000;
      }),
    });

    const process = await waitForProcess(42, {
      pollIntervalMs: 1,
      ctx,
      presenter,
      timeoutS: 30,
    });

    expect(process.state).toBe("idle");
  });

  it("propagates presenter failures to the caller", async () => {
    respondWith(["suspended"]);
    listAllPendingApprovals.mockResolvedValue([approvalStub("apr_1")]);

    const { presenter } = recordingPresenter({
      present: vi.fn(async () => {
        throw new Error("client does not support form elicitation");
      }),
    });

    await expect(
      waitForProcess(42, { ...WAIT, ctx, presenter }),
    ).rejects.toThrow(/does not support form elicitation/);
  });

  it("hands the suspended process back when a prompt goes unanswered past the budget", async () => {
    respondWith(["suspended"]);
    listAllPendingApprovals.mockResolvedValue([approvalStub("apr_1")]);

    // A prompt that never settles, as happens when the client advertises
    // elicitation but never answers.
    const { presenter } = recordingPresenter({
      present: vi.fn(() => new Promise<void>(() => {})),
    });

    const process = await waitForProcess(42, {
      ...WAIT,
      ctx,
      presenter,
      approvalWaitBudgetMs: 20,
    });

    expect(process.state).toBe("suspended");
    expect(process.pendingApprovalIds).toBeUndefined();
  });

  it("survives a prompt that fails after the budget was given up on", async () => {
    respondWith(["suspended"]);
    listAllPendingApprovals.mockResolvedValue([approvalStub("apr_1")]);

    let rejectLate: (err: Error) => void = () => {};
    const late = new Promise<void>((_resolve, reject) => {
      rejectLate = reject;
    });
    const { presenter } = recordingPresenter({ present: vi.fn(() => late) });

    const pending = waitForProcess(42, {
      ...WAIT,
      ctx,
      presenter,
      approvalWaitBudgetMs: 20,
    });
    await expect(pending).resolves.toMatchObject({ state: "suspended" });

    // The abandoned prompt rejecting later must not surface as an unhandled
    // rejection that takes the server down.
    expect(() => rejectLate(new Error("client went away"))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("treats timeoutS as seconds, not double seconds", async () => {
    const base = Date.now();
    // The run deadline is timeoutS * 1000 + 1000, so 40s is past a 30s budget.
    // A `* 2000` bug would still consider this inside the window.
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(base)
      .mockReturnValue(base + 40_000);

    respondWith(["running"]);
    await expect(waitForProcess(42, { ...WAIT, timeoutS: 30 })).rejects.toThrow(
      /did not become idle within the configured wait window/,
    );
  });

  it("keeps waiting while inside the run deadline", async () => {
    const base = Date.now();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(base)
      .mockReturnValue(base + 20_000);

    respondWith(["running", "idle"]);
    const process = await waitForProcess(42, { ...WAIT, timeoutS: 30 });
    expect(process.state).toBe("idle");
  });
});
