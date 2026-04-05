import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InvokeMessageResponse } from "@/models/invoke.model";
import type { ManifestTool } from "@/models/manifest.model";
import { AdapterModule } from "@/modules/adapter.module";
import {
  createProcessMessageSystem,
  type ProcessMessageChannel,
} from "@/services/invoke.service";

class TestProcessChannel extends EventEmitter implements ProcessMessageChannel {
  readonly sent: InvokeMessageResponse[] = [];

  send(message: InvokeMessageResponse): boolean {
    this.sent.push(message);
    return true;
  }
}

class TestManifestService {
  constructor(private readonly tools: ManifestTool[]) {}

  async getTool(_serviceId: string, toolId: string): Promise<ManifestTool> {
    const found = this.tools.find((tool) => tool.name === toolId);

    if (!found) {
      throw new Error(`Tool '${toolId}' not found`);
    }

    return found;
  }
}

const permissiveTool: ManifestTool = {
  name: "tool-1",
  inputSchema: {
    type: "object",
    additionalProperties: true,
  },
  outputSchema: {},
};

async function flushMessageHandling(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("invoke.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles process.invoke and sends process.response", async () => {
    const adapter = new AdapterModule();
    const invokeSpy = vi.spyOn(adapter, "invoke");
    const channel = new TestProcessChannel();
    const manifestService = new TestManifestService([permissiveTool]);

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", {
      type: "process.invoke",
      requestId: "req-1",
      serviceId: "service-1",
      toolId: "tool-1",
      parameters: { key: "value" },
    });

    await flushMessageHandling();

    expect(invokeSpy).toHaveBeenCalledWith("tool-1", { key: "value" });
    expect(channel.sent).toEqual([
      {
        type: "process.response",
        requestId: "req-1",
        output: "hello world",
      },
    ]);
  });

  it("ignores invalid process messages", async () => {
    const adapter = new AdapterModule();
    const invokeSpy = vi.spyOn(adapter, "invoke");
    const channel = new TestProcessChannel();
    const manifestService = new TestManifestService([permissiveTool]);

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", { type: "unknown" });
    channel.emit("message", null);
    channel.emit("message", {
      type: "process.invoke",
      requestId: "",
      serviceId: "service-1",
      toolId: "tool-1",
      parameters: {},
    });

    await flushMessageHandling();

    expect(invokeSpy).not.toHaveBeenCalled();
    expect(channel.sent).toEqual([]);
  });

  it("sends process.error when invoke throws", async () => {
    const adapter = new AdapterModule();
    const channel = new TestProcessChannel();
    const manifestService = new TestManifestService([permissiveTool]);

    vi.spyOn(adapter, "invoke").mockRejectedValueOnce(new Error("boom"));

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", {
      type: "process.invoke",
      requestId: "req-2",
      serviceId: "service-1",
      toolId: "tool-1",
      parameters: {},
    });

    await flushMessageHandling();

    expect(channel.sent).toEqual([
      {
        type: "process.error",
        requestId: "req-2",
        error: {
          message: "boom",
        },
      },
    ]);
  });

  it("sends process.error when input parameters do not match schema", async () => {
    const adapter = new AdapterModule();
    const invokeSpy = vi.spyOn(adapter, "invoke");
    const channel = new TestProcessChannel();
    const manifestService = new TestManifestService([
      {
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
      },
    ]);

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", {
      type: "process.invoke",
      requestId: "req-3",
      serviceId: "service-1",
      toolId: "tool-1",
      parameters: { count: "wrong" },
    });

    await flushMessageHandling();

    expect(invokeSpy).not.toHaveBeenCalled();
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toMatchObject({
      type: "process.error",
      requestId: "req-3",
    });
  });

  it("sends process.error when adapter output does not match schema", async () => {
    const adapter = new AdapterModule();
    const channel = new TestProcessChannel();
    const manifestService = new TestManifestService([
      {
        name: "tool-1",
        inputSchema: {},
        outputSchema: {
          type: "string",
        },
      },
    ]);

    vi.spyOn(adapter, "invoke").mockResolvedValueOnce(42 as never);

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", {
      type: "process.invoke",
      requestId: "req-4",
      serviceId: "service-1",
      toolId: "tool-1",
      parameters: {},
    });

    await flushMessageHandling();

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toMatchObject({
      type: "process.error",
      requestId: "req-4",
    });
  });
});
