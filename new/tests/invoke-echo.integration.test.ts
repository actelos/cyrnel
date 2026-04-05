import { EventEmitter } from "node:events";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { InvokeMessageResponse } from "@/models/invoke.model";
import { AdapterModule } from "@/modules/adapter.module";
import { ManifestService } from "@/services/manifest.service";
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

async function flushMessageHandling(channel: TestProcessChannel): Promise<void> {
  const timeoutMs = 1_000;
  const start = Date.now();

  while (channel.sent.length === 0 && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("invoke echo integration", () => {
  it("sends process.invoke to echo tool and receives echoed output", async () => {
    const adapter = new AdapterModule();
    const channel = new TestProcessChannel();
    const manifestService = new ManifestService(path.join(process.cwd(), "data"));

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", {
      type: "process.invoke",
      requestId: "req-echo",
      serviceId: "test-service",
      toolId: "echo",
      parameters: {
        input: "hello echo",
      },
    });

    await flushMessageHandling(channel);

    expect(channel.sent).toEqual([
      {
        type: "process.response",
        requestId: "req-echo",
        output: "hello echo",
      },
    ]);
  });
});
