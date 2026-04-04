import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

import { createAdapterToolPath, type ServerState } from "@/state";
import { createInvokeHandler } from "@/services/invoke.service";

const makeTool = (
  id = "echo",
  executorImpl: (input: unknown) => Promise<unknown> = async (input) => input,
  schemas: {
    inputSchema?: any;
    outputSchema?: any;
  } = {},
) => ({
  id,
  inputSchema: schemas.inputSchema ?? Schema.Struct({ value: Schema.Unknown }),
  outputSchema: schemas.outputSchema ?? Schema.Struct({ value: Schema.Unknown }),
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

const makeServerState = (catalog: ReturnType<typeof makeCatalogState>) =>
  ({
    modules: {
      config: {
        adapter: {},
      },
      loaded: {
        adapter: new Map(),
      },
      catalog,
      errors: new Map(),
    },
  }) as ServerState;

describe("invoke.service", () => {
  it("invokes tool output via process message", async () => {
    const tool = makeTool();
    const catalog = makeCatalogState({
      adapterId: "echo-adapter",
      serviceId: "echo",
      tools: [tool],
    });
    const handler = createInvokeHandler(makeServerState(catalog));

    const response = await handler({
      type: "tool.invoke",
      adapterId: "echo-adapter",
      serviceId: "echo",
      toolId: "echo",
      input: { value: "ok" },
    });

    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      type: "tool.response",
      requestId: undefined,
      output: { value: "ok" },
    });
  });

  it("rejects invalid ids", async () => {
    const tool = makeTool();
    const catalog = makeCatalogState({
      adapterId: "echo-adapter",
      serviceId: "echo",
      tools: [tool],
    });
    const handler = createInvokeHandler(makeServerState(catalog));

    const response = await handler({
      type: "tool.invoke",
      adapterId: "   ",
      serviceId: "echo",
      toolId: "echo",
      input: { value: "ok" },
    });

    expect(response).toEqual({
      type: "tool.error",
      requestId: undefined,
      error: {
        message: "Field 'adapterId' must not be empty.",
        statusCode: 400,
      },
    });
  });

  it("maps input parse errors to status 400", async () => {
    const tool = makeTool("echo", async (input) => input, {
      inputSchema: Schema.Struct({ value: Schema.String }),
    });
    const catalog = makeCatalogState({
      adapterId: "echo-adapter",
      serviceId: "echo",
      tools: [tool],
    });
    const handler = createInvokeHandler(makeServerState(catalog));

    const response = await handler({
      type: "tool.invoke",
      adapterId: "echo-adapter",
      serviceId: "echo",
      toolId: "echo",
      input: { value: 123 },
    });

    expect(response.type).toBe("tool.error");
    if (response.type === "tool.error") {
      expect(response.error.statusCode).toBe(400);
    }
  });

  it("maps output parse errors to status 502", async () => {
    const tool = makeTool("echo", async () => 123, {
      outputSchema: Schema.String,
    });
    const catalog = makeCatalogState({
      adapterId: "echo-adapter",
      serviceId: "echo",
      tools: [tool],
    });
    const handler = createInvokeHandler(makeServerState(catalog));

    const response = await handler({
      type: "tool.invoke",
      adapterId: "echo-adapter",
      serviceId: "echo",
      toolId: "echo",
      input: { value: "ok" },
    });

    expect(response).toEqual({
      type: "tool.error",
      requestId: undefined,
      error: {
        message: "Adapter tool output did not match its declared schema.",
        statusCode: 502,
      },
    });
  });

  it("returns 404 when service is missing", async () => {
    const catalog = makeCatalogState({
      adapterId: "echo-adapter",
      serviceId: "echo",
      tools: [makeTool()],
    });
    const handler = createInvokeHandler(makeServerState(catalog));

    const response = await handler({
      type: "tool.invoke",
      adapterId: "echo-adapter",
      serviceId: "missing",
      toolId: "echo",
      input: { value: "ok" },
    });

    expect(response).toEqual({
      type: "tool.error",
      requestId: undefined,
      error: {
        message: "Service \"missing\" not found.",
        statusCode: 404,
      },
    });
  });
});
