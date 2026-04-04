import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InvokeMessageResponse } from "@/models/invoke.model";
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

describe("invoke.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles process.invoke and sends process.response", async () => {
    const adapter = new AdapterModule();
    const invokeSpy = vi.spyOn(adapter, "invoke");
    const channel = new TestProcessChannel();

    createProcessMessageSystem(adapter, channel);

    channel.emit("message", {
      type: "process.invoke",
      requestId: "req-1",
      serviceId: "service-1",
      toolId: "tool-1",
      parameters: { key: "value" },
    });

    await Promise.resolve();

    expect(invokeSpy).toHaveBeenCalledWith("service-1", "tool-1", {
      key: "value",
    });
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

    createProcessMessageSystem(adapter, channel);

    channel.emit("message", { type: "unknown" });
    channel.emit("message", null);
    channel.emit("message", {
      type: "process.invoke",
      requestId: "",
      serviceId: "service-1",
      toolId: "tool-1",
      parameters: {},
    });

    await Promise.resolve();

    expect(invokeSpy).not.toHaveBeenCalled();
    expect(channel.sent).toEqual([]);
  });

  it("sends process.error when invoke throws", async () => {
    const adapter = new AdapterModule();
    const channel = new TestProcessChannel();

    vi.spyOn(adapter, "invoke").mockRejectedValueOnce(new Error("boom"));

    createProcessMessageSystem(adapter, channel);

    channel.emit("message", {
      type: "process.invoke",
      requestId: "req-2",
      serviceId: "service-1",
      toolId: "tool-1",
      parameters: {},
    });

    await Promise.resolve();

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
});
