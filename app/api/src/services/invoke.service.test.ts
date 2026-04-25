import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "@/logger";
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

class TestInboundOnlyChannel
  extends EventEmitter
  implements Omit<ProcessMessageChannel, "send"> {}

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
    description: "",
    enabled: true,
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
  serviceEnabled: true,
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
          description: "",
          enabled: true,
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
        serviceEnabled: true,
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
          description: "",
          enabled: true,
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
        serviceEnabled: true,
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

  it("sends invoke.error when tool is disabled", async () => {
    const adapter = new AdapterModule({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: vi.fn<typeof fetch>(),
    });
    const invokeSpy = vi.spyOn(adapter, "invoke");
    const channel = new TestProcessChannel();
    const manifestService = new TestManifestService([
      {
        ...permissiveTool,
        tool: {
          ...permissiveTool.tool,
          enabled: false,
        },
      },
    ]);

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", {
      type: "invoke.tool",
      requestId: "req-disabled-tool",
      serviceName: "service-1",
      toolName: "tool-1",
      parameters: {},
    });

    await flushMessageHandling();

    expect(invokeSpy).not.toHaveBeenCalled();
    expect(channel.sent).toEqual([
      {
        type: "invoke.error",
        requestId: "req-disabled-tool",
        message:
          "Tool 'tool-1' in service 'service-1' is disabled and cannot be invoked.",
      },
    ]);
  });

  it("sends invoke.error when service is disabled", async () => {
    const adapter = new AdapterModule({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: vi.fn<typeof fetch>(),
    });
    const invokeSpy = vi.spyOn(adapter, "invoke");
    const channel = new TestProcessChannel();
    const manifestService = new TestManifestService([
      {
        ...permissiveTool,
        serviceEnabled: false,
      },
    ]);

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", {
      type: "invoke.tool",
      requestId: "req-disabled-service",
      serviceName: "service-1",
      toolName: "tool-1",
      parameters: {},
    });

    await flushMessageHandling();

    expect(invokeSpy).not.toHaveBeenCalled();
    expect(channel.sent).toEqual([
      {
        type: "invoke.error",
        requestId: "req-disabled-service",
        message: "Service 'service-1' is disabled and cannot be invoked.",
      },
    ]);
  });

  it("warns once when channel.send is missing", () => {
    const adapter = new AdapterModule({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: vi.fn<typeof fetch>(),
    });
    const warnSpy = vi.spyOn(logger, "warn");
    const firstChannel = new TestInboundOnlyChannel();
    const secondChannel = new TestInboundOnlyChannel();

    createProcessMessageSystem(adapter, firstChannel);
    createProcessMessageSystem(adapter, secondChannel);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "createProcessMessageSystem configured with a channel that has no send(). onMessage will still call handleInvokeMessage, but invoke responses cannot be delivered.",
    );
  });

  it("keeps teardown behavior unchanged", () => {
    const adapter = new AdapterModule({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: vi.fn<typeof fetch>(),
    });
    const channel = new TestProcessChannel();
    const offSpy = vi.spyOn(channel, "off");

    const teardown = createProcessMessageSystem(adapter, channel);
    teardown();

    expect(offSpy).toHaveBeenCalledTimes(1);
    expect(offSpy).toHaveBeenCalledWith("message", expect.any(Function));
  });
});
