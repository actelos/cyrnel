import { Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "@/models/error";
import { createAdapterToolPath } from "@/state";
import { invokeTool } from "@/controllers/invoke.controller";

const makeRes = () => {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

const makeTool = (
  id = "echo",
  executorImpl: (input: unknown) => Promise<unknown> = async (input) => input,
) => ({
  id,
  inputSchema: Schema.Struct({ value: Schema.Unknown }),
  outputSchema: Schema.Struct({ value: Schema.Unknown }),
  execute: vi.fn(async () => executorImpl),
});

const makeCatalogState = (input: {
  adapterId: string;
  serviceId: string;
  tools: Array<ReturnType<typeof makeTool>>;
}) => {
  const service = {
    id: input.serviceId,
    tools: input.tools,
  };
  const services = new Map([
    [input.serviceId, { adapterId: input.adapterId, service }],
  ]);
  const tools = new Map<
    string,
    {
      adapterId: string;
      serviceId: string;
      toolId: string;
      toolPath: string;
      tool: ReturnType<typeof makeTool>;
    }
  >();

  for (const tool of input.tools) {
    const toolPath = createAdapterToolPath(
      input.adapterId,
      input.serviceId,
      tool.id,
    );
    tools.set(toolPath, {
      adapterId: input.adapterId,
      serviceId: input.serviceId,
      toolId: tool.id,
      toolPath,
      tool,
    });
  }

  return {
    services,
    tools,
  };
};

const makeReq = (
  body: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) => ({
  app: {
    locals: {
      serverState: {
        modules: {
          catalog: {
            services: new Map(),
            tools: new Map(),
          },
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

  it("invokes tool output by adapter, service and tool id", async () => {
    const res = makeRes();
    const tool = makeTool();
    const catalog = makeCatalogState({
      adapterId: "echo-adapter",
      serviceId: "echo",
      tools: [tool],
    });
    const req: any = makeReq(
      {
        adapterId: "echo-adapter",
        serviceId: "echo",
        toolId: "echo",
        input: { value: "ok" },
      },
      {
        app: {
          locals: {
            serverState: {
              modules: {
                catalog,
                loaded: { adapter: new Map() },
              },
            },
          },
        },
      },
    );

    await invokeTool(req, res);

    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ output: { value: "ok" } });
  });

  it("rejects invalid request body and ids", async () => {
    const res = makeRes();

    await expect(invokeTool(makeReq({}) as any, res)).rejects.toThrow(
      HttpError,
    );
    await expect(
      invokeTool(
        makeReq(
          { adapterId: "echo-adapter", serviceId: "echo", toolId: "echo" },
          { body: undefined },
        ) as any,
        res,
      ),
    ).rejects.toThrow(HttpError);

    await expect(
      invokeTool(
        makeReq({
          adapterId: "echo-adapter",
          serviceId: 123,
          toolId: "echo",
        }) as any,
        res,
      ),
    ).rejects.toThrow("Field 'serviceId' must be a string.");

    await expect(
      invokeTool(
        makeReq({ adapterId: "   ", serviceId: "echo", toolId: "echo" }) as any,
        res,
      ),
    ).rejects.toThrow("Field 'adapterId' must not be empty.");

    await expect(
      invokeTool(
        makeReq({
          adapterId: "echo-adapter",
          serviceId: "echo",
          toolId: "   ",
        }) as any,
        res,
      ),
    ).rejects.toThrow("Field 'toolId' must not be empty.");
  });

  it("returns 404 when service is not found", async () => {
    const res = makeRes();
    const catalog = makeCatalogState({
      adapterId: "echo-adapter",
      serviceId: "other-service",
      tools: [makeTool()],
    });
    const req: any = makeReq(
      {
        adapterId: "echo-adapter",
        serviceId: "echo",
        toolId: "echo",
        input: { value: "ok" },
      },
      {
        app: {
          locals: {
            serverState: {
              modules: {
                catalog,
                loaded: { adapter: new Map() },
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
    const catalog = makeCatalogState({
      adapterId: "echo-adapter",
      serviceId: "echo",
      tools: [makeTool("other-tool")],
    });
    const req: any = makeReq(
      {
        adapterId: "echo-adapter",
        serviceId: "echo",
        toolId: "echo",
        input: { value: "ok" },
      },
      {
        app: {
          locals: {
            serverState: {
              modules: {
                catalog,
                loaded: { adapter: new Map() },
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

  it("returns 409 when service belongs to a different adapter", async () => {
    const res = makeRes();
    const catalog = makeCatalogState({
      adapterId: "openapi",
      serviceId: "payments",
      tools: [makeTool("create-charge")],
    });
    const req: any = makeReq(
      {
        adapterId: "graphql",
        serviceId: "payments",
        toolId: "create-charge",
        input: { value: "ok" },
      },
      {
        app: {
          locals: {
            serverState: {
              modules: {
                catalog,
                loaded: { adapter: new Map() },
              },
            },
          },
        },
      },
    );

    await expect(invokeTool(req, res)).rejects.toThrow(
      'Service "payments" belongs to adapter "openapi", not "graphql".',
    );
  });

  it("dispatches to the catalogued adapter tool entry", async () => {
    const res = makeRes();
    const openApiTool = makeTool("echo", async (_input) => ({
      value: "from-openapi",
    }));
    const graphQlTool = makeTool("echo", async (_input) => ({
      value: "from-graphql",
    }));

    const openApiCatalog = makeCatalogState({
      adapterId: "openapi",
      serviceId: "billing",
      tools: [openApiTool],
    });
    const graphQlCatalog = makeCatalogState({
      adapterId: "graphql",
      serviceId: "users",
      tools: [graphQlTool],
    });
    const catalog = {
      services: new Map([
        ...openApiCatalog.services,
        ...graphQlCatalog.services,
      ]),
      tools: new Map([...openApiCatalog.tools, ...graphQlCatalog.tools]),
    };

    const req: any = makeReq(
      {
        adapterId: "graphql",
        serviceId: "users",
        toolId: "echo",
        input: { value: "ignored" },
      },
      {
        app: {
          locals: {
            serverState: {
              modules: {
                catalog,
                loaded: { adapter: new Map() },
              },
            },
          },
        },
      },
    );

    await invokeTool(req, res);

    expect(openApiTool.execute).not.toHaveBeenCalled();
    expect(graphQlTool.execute).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      output: { value: "from-graphql" },
    });
  });
});
