import type { Context, FastMCPSessionAuth } from "fastmcp";
import { UserError } from "fastmcp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApprovalPresenter,
  ElicitationApprovalPresenter,
  ManualApprovalPresenter,
} from "@/approval-presenter.js";
import type { PendingApproval } from "@/approvals.js";

const decideApproval = vi.hoisted(() => vi.fn());

vi.mock("@/approvals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/approvals.js")>();
  return { ...actual, decideApproval };
});

function approval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: "apr_1",
    serviceId: "github",
    toolId: "createIssue",
    processId: 42,
    parameters: { title: "hello" },
    state: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: 1_800_000_000_000,
    decidedAt: null,
    ...overrides,
  };
}

type Elicit = Context<FastMCPSessionAuth>["elicit"];

function makeCtx(elicit: Elicit): Context<FastMCPSessionAuth> {
  return {
    elicit,
    signal: new AbortController().signal,
  } as unknown as Context<FastMCPSessionAuth>;
}

beforeEach(() => {
  decideApproval.mockReset();
  decideApproval.mockResolvedValue("decided");
});

describe("ElicitationApprovalPresenter", () => {
  it("approves when the user accepts with approved=true", async () => {
    const elicit = vi.fn(async () => ({
      action: "accept",
      content: { approved: true },
    }));
    await new ElicitationApprovalPresenter().present({
      processId: 42,
      approvals: [approval()],
      ctx: makeCtx(elicit as unknown as Elicit),
    });

    expect(decideApproval).toHaveBeenCalledWith("apr_1", "approve");
  });

  it("denies when the user accepts with approved=false", async () => {
    const elicit = vi.fn(async () => ({
      action: "accept",
      content: { approved: false },
    }));
    await new ElicitationApprovalPresenter().present({
      processId: 42,
      approvals: [approval()],
      ctx: makeCtx(elicit as unknown as Elicit),
    });

    expect(decideApproval).toHaveBeenCalledWith("apr_1", "deny");
  });

  it("denies on decline", async () => {
    const elicit = vi.fn(async () => ({ action: "decline" }));
    await new ElicitationApprovalPresenter().present({
      processId: 42,
      approvals: [approval()],
      ctx: makeCtx(elicit as unknown as Elicit),
    });

    expect(decideApproval).toHaveBeenCalledWith("apr_1", "deny");
  });

  it("leaves approval pending on cancel", async () => {
    const elicit = vi.fn(async () => ({ action: "cancel" }));
    await new ElicitationApprovalPresenter().present({
      processId: 42,
      approvals: [approval()],
      ctx: makeCtx(elicit as unknown as Elicit),
    });

    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("treats an accept with no content as a denial", async () => {
    const elicit = vi.fn(async () => ({ action: "accept" }));
    await new ElicitationApprovalPresenter().present({
      processId: 42,
      approvals: [approval()],
      ctx: makeCtx(elicit as unknown as Elicit),
    });

    expect(decideApproval).toHaveBeenCalledWith("apr_1", "deny");
  });

  it("elicits each pending approval in order and applies mixed decisions", async () => {
    const elicit = vi
      .fn()
      .mockResolvedValueOnce({ action: "accept", content: { approved: true } })
      .mockResolvedValueOnce({ action: "decline" })
      .mockResolvedValueOnce({ action: "accept", content: { approved: true } });

    await new ElicitationApprovalPresenter().present({
      processId: 42,
      approvals: [
        approval({ id: "apr_a" }),
        approval({ id: "apr_b" }),
        approval({ id: "apr_c" }),
      ],
      ctx: makeCtx(elicit as unknown as Elicit),
    });

    expect(elicit).toHaveBeenCalledTimes(3);
    expect(decideApproval.mock.calls).toEqual([
      ["apr_a", "approve"],
      ["apr_b", "deny"],
      ["apr_c", "approve"],
    ]);
  });

  it("never lets the response choose which approval it applies to", async () => {
    const elicit = vi.fn(async () => ({
      action: "accept",
      content: { approved: true },
    }));
    await new ElicitationApprovalPresenter().present({
      processId: 42,
      approvals: [approval({ id: "apr_owner" })],
      ctx: makeCtx(elicit as unknown as Elicit),
    });

    const [params] = elicit.mock.calls[0] as unknown as [
      { message: string; requestedSchema: unknown },
    ];
    expect(Object.keys(params.requestedSchema as object)).toEqual([
      "type",
      "properties",
      "required",
    ]);
    expect(JSON.stringify(params)).not.toContain("apr_owner");
    expect(decideApproval).toHaveBeenCalledWith("apr_owner", "approve");
  });

  it("includes redacted parameters in the message", async () => {
    const elicit = vi.fn(async () => ({ action: "decline" }));
    await new ElicitationApprovalPresenter().present({
      processId: 42,
      approvals: [approval({ parameters: { apiToken: "leak-me" } })],
      ctx: makeCtx(elicit as unknown as Elicit),
    });

    const [params] = elicit.mock.calls[0] as unknown as [{ message: string }];
    expect(params.message).toContain("github.createIssue");
    expect(params.message).toContain("42");
    expect(params.message).not.toContain("leak-me");
    expect(params.message).toContain("***REDACTED***");
  });

  it("fails with actionable guidance when the client lacks elicitation", async () => {
    const elicit = vi.fn(async () => {
      throw new Error("Client does not support form elicitation.");
    });

    await expect(
      new ElicitationApprovalPresenter().present({
        processId: 42,
        approvals: [approval({ id: "apr_x" })],
        ctx: makeCtx(elicit as unknown as Elicit),
      }),
    ).rejects.toThrow(/CYRNEL_MCP_APPROVAL_METHOD=manual/);

    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("rethrows unrelated elicitation failures", async () => {
    const elicit = vi.fn(async () => {
      throw new Error("connection reset");
    });

    await expect(
      new ElicitationApprovalPresenter().present({
        processId: 42,
        approvals: [approval()],
        ctx: makeCtx(elicit as unknown as Elicit),
      }),
    ).rejects.toThrow("connection reset");
  });

  it("surfaces already-decided races without failing the round", async () => {
    decideApproval.mockResolvedValue("already-decided");
    const elicit = vi.fn(async () => ({
      action: "accept",
      content: { approved: true },
    }));

    await expect(
      new ElicitationApprovalPresenter().present({
        processId: 42,
        approvals: [approval()],
        ctx: makeCtx(elicit as unknown as Elicit),
      }),
    ).resolves.toBeUndefined();
  });

  it("aborts before eliciting when the request signal is already aborted", async () => {
    const elicit = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const ctx = {
      elicit,
      signal: controller.signal,
    } as unknown as Context<FastMCPSessionAuth>;

    await expect(
      new ElicitationApprovalPresenter().present({
        processId: 42,
        approvals: [approval()],
        ctx,
      }),
    ).rejects.toBeInstanceOf(UserError);
    expect(elicit).not.toHaveBeenCalled();
    expect(decideApproval).not.toHaveBeenCalled();
  });
});

describe("ManualApprovalPresenter", () => {
  it("does not resolve approvals in-band", () => {
    expect(new ManualApprovalPresenter().inBand).toBe(false);
  });

  it("refuses to present", async () => {
    await expect(new ManualApprovalPresenter().present()).rejects.toThrow(
      /cannot resolve approvals in-band/,
    );
  });
});

describe("createApprovalPresenter", () => {
  it("selects the elicitation presenter by default", () => {
    const presenter = createApprovalPresenter("elicitation");
    expect(presenter).toBeInstanceOf(ElicitationApprovalPresenter);
    expect(presenter.inBand).toBe(true);
  });

  it("selects the manual presenter when configured", () => {
    const presenter = createApprovalPresenter("manual");
    expect(presenter).toBeInstanceOf(ManualApprovalPresenter);
    expect(presenter.inBand).toBe(false);
  });
});
