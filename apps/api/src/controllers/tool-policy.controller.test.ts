import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createToolPolicyRule,
  deleteToolPolicyRule,
  getAffectedTools,
  listToolPolicyRules,
  previewToolPolicyPattern,
  reorderToolPolicyRules,
  updateToolPolicyRule,
} from "@/controllers/tool-policy.controller";
import { HttpError } from "@/models/error.model";

const toolPoliciesService = {
  listRules: vi.fn(),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  deleteRule: vi.fn(),
  reorderRules: vi.fn(),
  getAffectedTools: vi.fn(),
  previewPattern: vi.fn(),
};

interface MockResponse {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

const makeRes = (): MockResponse => {
  const res = {} as MockResponse;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
};

const makeReq = (overrides: Record<string, unknown> = {}): Request =>
  ({
    app: { locals: { toolPoliciesService } },
    params: {},
    query: {},
    body: {},
    ...overrides,
  }) as unknown as Request;

const cast = (res: MockResponse) => res as unknown as Response;

describe("tool-policy.controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws if toolPoliciesService is missing from app.locals", async () => {
    const res = makeRes();
    const req = {
      app: { locals: {} },
      params: {},
      query: {},
      body: {},
    } as unknown as Request;

    await expect(listToolPolicyRules(req, cast(res))).rejects.toThrow(
      /ToolPoliciesService not configured/,
    );
  });

  it("lists rules", async () => {
    const res = makeRes();
    toolPoliciesService.listRules.mockResolvedValue([{ id: "tpr_1" }]);

    await listToolPolicyRules(makeReq(), cast(res));

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith([{ id: "tpr_1" }]);
  });

  it("creates a rule with 201", async () => {
    const res = makeRes();
    toolPoliciesService.createRule.mockResolvedValue({ id: "tpr_1" });

    await createToolPolicyRule(
      makeReq({
        body: {
          servicePattern: "github",
          toolPattern: "*",
          decision: "allow",
        },
      }),
      cast(res),
    );

    expect(toolPoliciesService.createRule).toHaveBeenCalledWith({
      servicePattern: "github",
      toolPattern: "*",
      decision: "allow",
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("rejects invalid patterns", async () => {
    const res = makeRes();
    await expect(
      createToolPolicyRule(
        makeReq({
          body: { servicePattern: "a*b", toolPattern: "*", decision: "allow" },
        }),
        cast(res),
      ),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("updates a rule", async () => {
    const res = makeRes();
    toolPoliciesService.updateRule.mockResolvedValue({ id: "tpr_1" });

    await updateToolPolicyRule(
      makeReq({ params: { id: "tpr_1" }, body: { decision: "block" } }),
      cast(res),
    );

    expect(toolPoliciesService.updateRule).toHaveBeenCalledWith("tpr_1", {
      decision: "block",
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("deletes a rule with 204", async () => {
    const res = makeRes();
    toolPoliciesService.deleteRule.mockResolvedValue(undefined);

    await deleteToolPolicyRule(makeReq({ params: { id: "tpr_1" } }), cast(res));

    expect(toolPoliciesService.deleteRule).toHaveBeenCalledWith("tpr_1");
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("reorders rules", async () => {
    const res = makeRes();
    toolPoliciesService.reorderRules.mockResolvedValue([]);

    await reorderToolPolicyRules(
      makeReq({ body: { orderedIds: ["tpr_2", "tpr_1"] } }),
      cast(res),
    );

    expect(toolPoliciesService.reorderRules).toHaveBeenCalledWith([
      "tpr_2",
      "tpr_1",
    ]);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("fetches affected tools with pagination", async () => {
    const res = makeRes();
    toolPoliciesService.getAffectedTools.mockResolvedValue({
      items: [],
      nextCursor: null,
      hasMore: false,
    });

    await getAffectedTools(
      makeReq({ params: { id: "tpr_1" }, query: { limit: "10" } }),
      cast(res),
    );

    expect(toolPoliciesService.getAffectedTools).toHaveBeenCalledWith("tpr_1", {
      limit: 10,
      cursor: undefined,
    });
  });

  it("previews an unsaved pattern", async () => {
    const res = makeRes();
    toolPoliciesService.previewPattern.mockResolvedValue({
      matchCount: 0,
      items: [],
    });

    await previewToolPolicyPattern(
      makeReq({ query: { servicePattern: "github", toolPattern: "*" } }),
      cast(res),
    );

    expect(toolPoliciesService.previewPattern).toHaveBeenCalledWith({
      servicePattern: "github",
      toolPattern: "*",
      limit: 20,
    });
  });
});
