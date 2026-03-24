import { Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "@/models/error";
import { invokeTool } from "@/controllers/invoke.controller";

const makeRes = () => {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

const makeTool = () => ({
  id: "echo",
  inputSchema: Schema.Struct({ value: Schema.Unknown }),
  outputSchema: Schema.Struct({ value: Schema.Unknown }),
  execute: vi.fn(async () => async (input: unknown) => input),
});

const makeReq = (
  body: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) => ({
  app: {
    locals: {
      serverState: {
        modules: {
          loaded: {
            adapter: new Map(),
          },
        },
      },
    },
  },
  body,
  ...overrides,
});

describe("invoke.controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes tool output by service and tool id", async () => {
    const res = makeRes();
    const tool = makeTool();
    const parse = vi.fn(async () => ({
      id: "echo",
      tools: [tool],
    }));
    const req: any = makeReq(
      {
        serviceId: "echo",
        toolId: "echo",
        input: { value: "ok" },
      },
      {
        app: {
          locals: {
            serverState: {
              modules: {
                loaded: {
                  adapter: new Map([["echo-module", { parse }]]),
                },
              },
            },
          },
        },
      },
    );

    await invokeTool(req, res);

    expect(parse).toHaveBeenCalledTimes(1);
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ output: { value: "ok" } });
  });

  it("rejects invalid request body and ids", async () => {
    const res = makeRes();

    await expect(invokeTool(makeReq({}) as any, res)).rejects.toThrow(HttpError);
    await expect(
      invokeTool(
        makeReq({ serviceId: "echo", toolId: "echo" }, { body: undefined }) as any,
        res,
      ),
    ).rejects.toThrow(HttpError);

    await expect(
      invokeTool(makeReq({ serviceId: 123, toolId: "echo" }) as any, res),
    ).rejects.toThrow("Field 'serviceId' must be a string.");

    await expect(
      invokeTool(makeReq({ serviceId: "echo", toolId: "   " }) as any, res),
    ).rejects.toThrow("Field 'toolId' must not be empty.");
  });

  it("returns 404 when service is not found", async () => {
    const res = makeRes();
    const parse = vi.fn(async () => ({
      id: "other-service",
      tools: [makeTool()],
    }));
    const req: any = makeReq(
      {
        serviceId: "echo",
        toolId: "echo",
        input: { value: "ok" },
      },
      {
        app: {
          locals: {
            serverState: {
              modules: {
                loaded: {
                  adapter: new Map([["echo-module", { parse }]]),
                },
              },
            },
          },
        },
      },
    );

    await expect(invokeTool(req, res)).rejects.toThrow(
      'Service "echo" not found.',
    );
  });

  it("returns 404 when tool is not found", async () => {
    const res = makeRes();
    const parse = vi.fn(async () => ({
      id: "echo",
      tools: [{ ...makeTool(), id: "other-tool" }],
    }));
    const req: any = makeReq(
      {
        serviceId: "echo",
        toolId: "echo",
        input: { value: "ok" },
      },
      {
        app: {
          locals: {
            serverState: {
              modules: {
                loaded: {
                  adapter: new Map([["echo-module", { parse }]]),
                },
              },
            },
          },
        },
      },
    );

    await expect(invokeTool(req, res)).rejects.toThrow(
      'Tool "echo" not found for service "echo".',
    );
  });
});