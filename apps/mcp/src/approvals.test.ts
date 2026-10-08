import { HTTPError, type NormalizedOptions } from "ky";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideApproval,
  isSensitiveKey,
  listAllPendingApprovals,
  listApprovals,
  summarizeParameters,
} from "@/approvals.js";

vi.mock("@/fetch.js", () => ({
  api: { get: vi.fn(), post: vi.fn() },
  searchParams: (params: Record<string, unknown>) => params,
}));

const { api } = await import("@/fetch.js");
const get = vi.mocked(api.get);
const post = vi.mocked(api.post);

function page(items: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    json: async () => ({
      items,
      nextCursor: null,
      hasMore: false,
      ...overrides,
    }),
  };
}

function approvalRow(overrides: Record<string, unknown> = {}) {
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

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

/** ky 2 requires the normalized options snapshot that produced the error. */
function normalizedOptions(): NormalizedOptions {
  return {
    method: "POST",
    retry: {},
    prefix: "",
    context: {},
    onDownloadProgress: undefined,
    onUploadProgress: undefined,
  };
}

describe("summarizeParameters", () => {
  it("returns an empty object for missing parameters", () => {
    expect(summarizeParameters(null)).toBe("{}");
    expect(summarizeParameters(undefined)).toBe("{}");
  });

  it("keeps non-sensitive parameters readable", () => {
    expect(summarizeParameters({ title: "hello", draft: false })).toBe(
      '{"title":"hello","draft":false}',
    );
  });

  it("redacts secret-looking keys at any depth", () => {
    const summary = summarizeParameters({
      owner: "actelos",
      credentials: { apiToken: "abc123" },
      nested: { deep: { client_secret: "shh" } },
    });
    expect(summary).not.toContain("abc123");
    expect(summary).not.toContain("shh");
    expect(summary).toContain("***REDACTED***");
    expect(summary).toContain("actelos");
  });

  it("truncates long output rather than dumping it", () => {
    const summary = summarizeParameters({ blob: "x".repeat(5000) }, 100);
    expect(summary.length).toBeLessThan(160);
    expect(summary).toContain("(truncated)");
  });

  it("truncates long strings inside parameters", () => {
    const summary = summarizeParameters({ note: "y".repeat(1000) });
    expect(summary).not.toContain("y".repeat(500));
  });

  it("bounds arrays and object key counts", () => {
    const many = summarizeParameters({
      items: Array.from({ length: 50 }, (_, i) => i),
    });
    expect(many).toContain("more");

    const wide = summarizeParameters(
      Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i])),
    );
    expect(wide).toContain("more keys");
  });

  it("bounds self-referential parameters without hanging or overflowing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const summary = summarizeParameters(cyclic);
    expect(summary).toContain("...");
    expect(summary.length).toBeLessThan(600);
  });
});

describe("isSensitiveKey", () => {
  it("matches credential-bearing keys", () => {
    for (const key of [
      "password",
      "API_KEY",
      "apiKey",
      "refresh_token",
      "clientSecret",
      "Authorization",
      "Cookie",
      "signature",
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  it("leaves ordinary keys alone", () => {
    for (const key of ["title", "owner", "repo", "author", "path", "body"]) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });
});

describe("listApprovals", () => {
  it("maps rows and requests the pending state filter", async () => {
    get.mockReturnValue(page([approvalRow()]) as never);
    const result = await listApprovals({ processId: 42, state: "pending" });

    expect(get).toHaveBeenCalledWith(
      "approvals",
      expect.objectContaining({
        searchParams: expect.objectContaining({
          state: "pending",
          processId: 42,
        }),
      }),
    );
    expect(result.items[0]).toMatchObject({
      id: "apr_1",
      serviceId: "github",
      toolId: "createIssue",
      processId: 42,
      state: "pending",
    });
  });

  it("rejects an unexpected response shape", async () => {
    get.mockReturnValue({ json: async () => ({ nope: true }) } as never);
    await expect(listApprovals({})).rejects.toThrow(
      /unexpected response shape/,
    );
  });

  it("defaults missing optional fields", async () => {
    get.mockReturnValue(
      page([
        { id: "apr_2", serviceId: "github", toolId: "createIssue" },
      ]) as never,
    );
    const result = await listApprovals({});
    expect(result.items[0]).toMatchObject({
      processId: null,
      parameters: {},
      createdAt: null,
      expiresAt: null,
    });
  });
});

describe("listAllPendingApprovals", () => {
  it("follows pagination until exhausted", async () => {
    get
      .mockReturnValueOnce(
        page([approvalRow({ id: "apr_1" })], {
          nextCursor: "c1",
          hasMore: true,
        }) as never,
      )
      .mockReturnValueOnce(
        page([approvalRow({ id: "apr_2" })], { hasMore: false }) as never,
      );

    const all = await listAllPendingApprovals(42);
    expect(all.map((a) => a.id)).toEqual(["apr_1", "apr_2"]);
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("decideApproval", () => {
  function httpError(status: number) {
    return new HTTPError(
      new Response(null, { status }),
      new Request("http://localhost/approvals/apr_1/approve"),
      normalizedOptions(),
    );
  }

  it("reports a successful decision", async () => {
    post.mockReturnValue({ json: async () => ({}) } as never);
    await expect(decideApproval("apr_1", "approve")).resolves.toBe("decided");
    expect(post).toHaveBeenCalledWith(
      "approvals/apr_1/approve",
      expect.objectContaining({ json: {} }),
    );
  });

  it("treats 409 as already decided", async () => {
    post.mockImplementation(() => {
      throw httpError(409);
    });
    await expect(decideApproval("apr_1", "deny")).resolves.toBe(
      "already-decided",
    );
  });

  it("treats 404 as not found", async () => {
    post.mockImplementation(() => {
      throw httpError(404);
    });
    await expect(decideApproval("apr_1", "approve")).resolves.toBe("not-found");
  });

  it("propagates other failures", async () => {
    post.mockImplementation(() => {
      throw httpError(500);
    });
    await expect(decideApproval("apr_1", "approve")).rejects.toBeInstanceOf(
      HTTPError,
    );
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
