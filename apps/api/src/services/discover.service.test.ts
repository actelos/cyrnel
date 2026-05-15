import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscoverResponse } from "@/models/discover.model";
import {
  createDiscoverMessageSystem,
  type DiscoverMessageChannel,
} from "@/services/discover.service";

class TestDiscoverChannel
  extends EventEmitter
  implements DiscoverMessageChannel
{
  readonly sent: DiscoverResponse[] = [];

  send(message: DiscoverResponse): boolean {
    this.sent.push(message);
    return true;
  }
}

const manifestService = {
  discoverTools: vi.fn(),
  discoverServices: vi.fn(),
  getTool: vi.fn(),
  getService: vi.fn(),
};

async function flushMessageHandling(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("discover.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles discover.tools and sends tools.response", async () => {
    const channel = new TestDiscoverChannel();
    manifestService.discoverTools.mockResolvedValueOnce([
      {
        serviceName: "svc-1",
        name: "echo",
        description: "Echo",
        enabled: true,
      },
    ]);

    createDiscoverMessageSystem(channel, { manifestService });

    channel.emit("message", {
      type: "discover.tools",
      requestId: "req-tools-1",
      query: "echo",
    });

    await flushMessageHandling();

    expect(manifestService.discoverTools).toHaveBeenCalledWith(
      "echo",
      undefined,
    );
    expect(channel.sent).toEqual([
      {
        type: "tools.response",
        requestId: "req-tools-1",
        tools: [
          {
            serviceName: "svc-1",
            name: "echo",
            description: "Echo",
            enabled: true,
          },
        ],
      },
    ]);
  });

  it("handles discover.services and sends services.response", async () => {
    const channel = new TestDiscoverChannel();
    manifestService.discoverServices.mockResolvedValueOnce([
      {
        name: "svc-1",
        description: "Service",
        enabled: true,
      },
    ]);

    createDiscoverMessageSystem(channel, { manifestService });

    channel.emit("message", {
      type: "discover.services",
      requestId: "req-services-1",
      query: "svc",
    });

    await flushMessageHandling();

    expect(manifestService.discoverServices).toHaveBeenCalledWith(
      "svc",
      undefined,
    );
    expect(channel.sent).toEqual([
      {
        type: "services.response",
        requestId: "req-services-1",
        services: [
          {
            name: "svc-1",
            description: "Service",
            enabled: true,
          },
        ],
      },
    ]);
  });

  it("sends tools.error when discoverTools fails", async () => {
    const channel = new TestDiscoverChannel();
    manifestService.discoverTools.mockRejectedValueOnce(new Error("boom"));

    createDiscoverMessageSystem(channel, { manifestService });

    channel.emit("message", {
      type: "discover.tools",
      requestId: "req-tools-2",
      query: "echo",
    });

    await flushMessageHandling();

    expect(channel.sent).toEqual([
      {
        type: "tools.error",
        requestId: "req-tools-2",
        message: "boom",
      },
    ]);
  });

  it("handles discover.tool and sends tool.response", async () => {
    const channel = new TestDiscoverChannel();
    manifestService.getTool.mockResolvedValueOnce({
      tool: {
        name: "echo",
        description: "Echo",
        enabled: true,
        inputSchema: {},
        outputSchema: {},
        metadata: { foo: "bar" },
      },
      serviceMetadata: { service: "meta" },
      serviceEnabled: true,
    });

    createDiscoverMessageSystem(channel, { manifestService });

    channel.emit("message", {
      type: "discover.tool",
      requestId: "req-tool-1",
      serviceName: "svc-1",
      toolName: "echo",
    });

    await flushMessageHandling();

    expect(manifestService.getTool).toHaveBeenCalledWith("svc-1", "echo");
    expect(channel.sent).toEqual([
      {
        type: "tool.response",
        requestId: "req-tool-1",
        tool: {
          name: "echo",
          description: "Echo",
          enabled: true,
          inputSchema: {},
          outputSchema: {},
          metadata: { foo: "bar" },
        },
        serviceName: "svc-1",
        serviceEnabled: true,
        serviceMetadata: { service: "meta" },
      },
    ]);
  });

  it("handles discover.service and sends service.response", async () => {
    const channel = new TestDiscoverChannel();
    manifestService.getService.mockResolvedValueOnce({
      name: "svc-1",
      type: "adapter",
      source: "https://example.com/manifest.json",
      description: "Service",
      hash: "hash-1",
      enabled: true,
      configSchema: {},
      secretsSchema: {},
      metadata: { env: "prod" },
    });

    createDiscoverMessageSystem(channel, { manifestService });

    channel.emit("message", {
      type: "discover.service",
      requestId: "req-service-1",
      serviceName: "svc-1",
    });

    await flushMessageHandling();

    expect(manifestService.getService).toHaveBeenCalledWith("svc-1");
    expect(channel.sent).toEqual([
      {
        type: "service.response",
        requestId: "req-service-1",
        service: {
          name: "svc-1",
          type: "adapter",
          source: "https://example.com/manifest.json",
          description: "Service",
          hash: "hash-1",
          enabled: true,
          configSchema: {},
          secretsSchema: {},
          metadata: { env: "prod" },
        },
      },
    ]);
  });

  it("passes the discover limit through to manifestService", async () => {
    const channel = new TestDiscoverChannel();
    manifestService.discoverTools.mockResolvedValueOnce([]);

    createDiscoverMessageSystem(channel, { manifestService });

    channel.emit("message", {
      type: "discover.tools",
      requestId: "req-tools-limit",
      query: "github",
      limit: 5,
    });

    await flushMessageHandling();

    expect(manifestService.discoverTools).toHaveBeenCalledWith("github", 5);
  });

  it("passes enabled filter through to discover.tools", async () => {
    const channel = new TestDiscoverChannel();
    manifestService.discoverTools.mockResolvedValueOnce([]);

    createDiscoverMessageSystem(channel, { manifestService });

    channel.emit("message", {
      type: "discover.tools",
      requestId: "req-tools-enabled",
      query: "github",
      enabled: null,
    });

    await flushMessageHandling();

    expect(manifestService.discoverTools).toHaveBeenCalledWith(
      "github",
      undefined,
      null,
    );
  });

  it("passes enabled filter through to discover.services", async () => {
    const channel = new TestDiscoverChannel();
    manifestService.discoverServices.mockResolvedValueOnce([]);

    createDiscoverMessageSystem(channel, { manifestService });

    channel.emit("message", {
      type: "discover.services",
      requestId: "req-services-enabled",
      query: "github",
      enabled: false,
    });

    await flushMessageHandling();

    expect(manifestService.discoverServices).toHaveBeenCalledWith(
      "github",
      undefined,
      false,
    );
  });

  it("ignores invalid process messages", async () => {
    const channel = new TestDiscoverChannel();

    createDiscoverMessageSystem(channel, { manifestService });

    channel.emit("message", { type: "unknown" });
    channel.emit("message", {
      type: "discover.services",
      requestId: "",
      query: "svc",
    });
    channel.emit("message", {
      type: "discover.tools",
      requestId: "req-tools-3",
      query: 42,
    });
    channel.emit("message", {
      type: "discover.tools",
      requestId: "req-tools-4",
      query: "ok",
      limit: 0,
    });
    channel.emit("message", {
      type: "discover.services",
      requestId: "req-services-2",
      query: "ok",
      enabled: "yes",
    });
    channel.emit("message", {
      type: "discover.tool",
      requestId: "req-tool-invalid",
      serviceName: "",
      toolName: "ok",
    });
    channel.emit("message", {
      type: "discover.service",
      requestId: "req-service-invalid",
      serviceName: "",
    });

    await flushMessageHandling();

    expect(manifestService.discoverTools).not.toHaveBeenCalled();
    expect(manifestService.discoverServices).not.toHaveBeenCalled();
    expect(manifestService.getTool).not.toHaveBeenCalled();
    expect(manifestService.getService).not.toHaveBeenCalled();
    expect(channel.sent).toEqual([]);
  });
});
