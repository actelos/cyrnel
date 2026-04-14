import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  InvokeResponse,
  ResolvedToolInvocation,
} from "@/models/invoke.model";
import { AdapterModule } from "@/modules/adapter.module";
import {
  createProcessMessageSystem,
  type ProcessMessageChannel,
} from "@/services/invoke.service";

class TestProcessChannel extends EventEmitter implements ProcessMessageChannel {
  readonly sent: InvokeResponse[] = [];

  send(message: InvokeResponse): boolean {
    this.sent.push(message);
    return true;
  }
}

class TestManifestService {
  constructor(private readonly tools: ResolvedToolInvocation[]) {}

  async getTool(
    _serviceName: string,
    toolName: string,
  ): Promise<ResolvedToolInvocation> {
    const found = this.tools.find((tool) => tool.tool.name === toolName);

    if (!found) {
      throw new Error(`Tool '${toolName}' not found`);
    }

    return found;
  }
}

const permissiveTool: ResolvedToolInvocation = {
  tool: {
    name: "tool-1",
    inputSchema: {
      type: "object",
      additionalProperties: true,
    },
    outputSchema: {},
    metadata: {
      requestKind: "rpc.invoke",
      route: "tool-1",
    },
  },
  serviceMetadata: {
    serverUrl: "http://127.0.0.1:9999",
  },
};

async function flushMessageHandling(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("invoke.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles invoke.tool and sends invoke.response", async () => {
    const adapter = new AdapterModule({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: vi.fn<typeof fetch>(),
    });
    const invokeSpy = vi.spyOn(adapter, "invoke");
    invokeSpy.mockResolvedValueOnce("hello world");
    const channel = new TestProcessChannel();
    const manifestService = new TestManifestService([permissiveTool]);

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", {
      type: "invoke.tool",
      requestId: "req-1",
      serviceName: "service-1",
      toolName: "tool-1",
      parameters: { key: "value" },
    });

    await flushMessageHandling();

    expect(invokeSpy).toHaveBeenCalledWith(
      "tool-1",
      { key: "value" },
      {
        serviceMetadata: permissiveTool.serviceMetadata,
        toolMetadata: permissiveTool.tool.metadata,
      },
    );
    expect(channel.sent).toEqual([
      {
        type: "invoke.response",
        requestId: "req-1",
        output: "hello world",
      },
    ]);
  });

  it("ignores invalid process messages", async () => {
    const adapter = new AdapterModule({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: vi.fn<typeof fetch>(),
    });
    const invokeSpy = vi.spyOn(adapter, "invoke");
    const channel = new TestProcessChannel();
    const manifestService = new TestManifestService([permissiveTool]);

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", { type: "unknown" });
    channel.emit("message", null);
    channel.emit("message", {
      type: "invoke.tool",
      requestId: "",
      serviceName: "service-1",
      toolName: "tool-1",
      parameters: {},
    });

    await flushMessageHandling();

    expect(invokeSpy).not.toHaveBeenCalled();
    expect(channel.sent).toEqual([]);
  });

  it("sends invoke.error when invoke throws", async () => {
    const adapter = new AdapterModule({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: vi.fn<typeof fetch>(),
    });
    const channel = new TestProcessChannel();
    const manifestService = new TestManifestService([permissiveTool]);

    vi.spyOn(adapter, "invoke").mockRejectedValueOnce(new Error("boom"));

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", {
      type: "invoke.tool",
      requestId: "req-2",
      serviceName: "service-1",
      toolName: "tool-1",
      parameters: {},
    });

    await flushMessageHandling();

    expect(channel.sent).toEqual([
      {
        type: "invoke.error",
        requestId: "req-2",
        message: "boom",
      },
    ]);
  });

  it("sends invoke.error when input parameters do not match schema", async () => {
    const adapter = new AdapterModule({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: vi.fn<typeof fetch>(),
    });
    const invokeSpy = vi.spyOn(adapter, "invoke");
    const channel = new TestProcessChannel();
    const manifestService = new TestManifestService([
      {
        tool: {
          name: "tool-1",
          inputSchema: {
            type: "object",
            required: ["count"],
            properties: {
              count: { type: "number" },
            },
            additionalProperties: false,
          },
          outputSchema: {},
          metadata: {
            requestKind: "rpc.invoke",
            route: "tool-1",
          },
        },
        serviceMetadata: {
          serverUrl: "http://127.0.0.1:9999",
        },
      },
    ]);

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", {
      type: "invoke.tool",
      requestId: "req-3",
      serviceName: "service-1",
      toolName: "tool-1",
      parameters: { count: "wrong" },
    });

    await flushMessageHandling();

    expect(invokeSpy).not.toHaveBeenCalled();
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toMatchObject({
      type: "invoke.error",
      requestId: "req-3",
    });
  });

  it("sends invoke.error when adapter output does not match schema", async () => {
    const adapter = new AdapterModule({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: vi.fn<typeof fetch>(),
    });
    const channel = new TestProcessChannel();
    const manifestService = new TestManifestService([
      {
        tool: {
          name: "tool-1",
          inputSchema: {},
          outputSchema: {
            type: "string",
          },
          metadata: {
            requestKind: "rpc.invoke",
            route: "tool-1",
          },
        },
        serviceMetadata: {
          serverUrl: "http://127.0.0.1:9999",
        },
      },
    ]);

    vi.spyOn(adapter, "invoke").mockResolvedValueOnce(42 as never);

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", {
      type: "invoke.tool",
      requestId: "req-4",
      serviceName: "service-1",
      toolName: "tool-1",
      parameters: {},
    });

    await flushMessageHandling();

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toMatchObject({
      type: "invoke.error",
      requestId: "req-4",
    });
  });
});
