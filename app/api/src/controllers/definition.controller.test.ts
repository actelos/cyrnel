import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDefinition,
  deleteDefinition,
  getDefinition,
  listDefinitions,
} from "@/controllers/definition.controller";

const definitionService = {
  listDefinitions: vi.fn(),
  getDefinition: vi.fn(),
  createDefinition: vi.fn(),
  deleteDefinition: vi.fn(),
};

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

const makeRes = () => {
  const res = {} as MockResponse;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
};

const makeReq = (overrides: Record<string, unknown> = {}) =>
  ({
    app: { locals: { definitionService } },
    params: {},
    query: {},
    body: {},
    ...overrides,
  }) as unknown as Request;

describe("definition.controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists definitions", async () => {
    const res = makeRes();
    const req = makeReq();
    definitionService.listDefinitions.mockResolvedValue([
      { id: "def-1", type: "foo", hash: "hash-1" },
      { id: "def-2", type: "foo", hash: "hash-2" },
    ]);

    await listDefinitions(req, res as unknown as Response);

    expect(definitionService.listDefinitions).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      definitions: [
        { id: "def-1", type: "foo", hash: "hash-1" },
        { id: "def-2", type: "foo", hash: "hash-2" },
      ],
    });
  });

  it("gets a definition", async () => {
    const res = makeRes();
    const req = makeReq({ params: { definitionId: "def-1" } });
    definitionService.getDefinition.mockResolvedValue({
      id: "def-1",
      type: "foo",
      hash: "hash-1",
    });

    await getDefinition(req, res as unknown as Response);

    expect(definitionService.getDefinition).toHaveBeenCalledWith("def-1");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      id: "def-1",
      type: "foo",
      hash: "hash-1",
    });
  });

  it("creates a definition", async () => {
    const res = makeRes();
    const req = makeReq({
      query: { type: "foo" },
      body: Buffer.from('{"name":"svc-def","metadata":{},"tools":[]}'),
    });
    definitionService.createDefinition.mockResolvedValue({
      id: "def-1",
      type: "foo",
      hash: "hash-1",
    });

    await createDefinition(req, res as unknown as Response);

    expect(definitionService.createDefinition).toHaveBeenCalledWith(
      "foo",
      '{"name":"svc-def","metadata":{},"tools":[]}',
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      id: "def-1",
      type: "foo",
      hash: "hash-1",
    });
  });

  it("deletes a definition", async () => {
    const res = makeRes();
    const req = makeReq({ params: { definitionId: "def-1" } });

    await deleteDefinition(req, res as unknown as Response);

    expect(definitionService.deleteDefinition).toHaveBeenCalledWith("def-1");
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalledWith();
  });
});
