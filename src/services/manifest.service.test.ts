import { describe, expect, it } from "vitest";

import type { ManifestMetadata, ToolDefinition } from "@/models/manifest.model";
import { ManifestService } from "@/services/manifest.service";

describe("manifest.service", () => {
  it("loads tool schemas from the tool record", async () => {
    const metadata: ManifestMetadata = {
      serverUrl: "http://127.0.0.1:8787",
    };
    const toolDefinition: ToolDefinition = {
      name: "tool-1",
      metadata: {
        requestKind: "rpc.invoke",
        route: "echo",
      },
      inputSchema: {
        type: "object",
        properties: {
          count: { type: "number" },
        },
      },
      outputSchema: {
        type: "string",
      },
    };
    const service = new ManifestService(
      async (serviceId) => (serviceId === "svc-1" ? metadata : null),
      async (serviceId, toolId) =>
        serviceId === "svc-1" && toolId === "tool-1" ? toolDefinition : null,
    );

    const tool = await service.getTool("svc-1", "tool-1");

    expect(tool).toMatchObject({
      tool: {
        name: "tool-1",
        inputSchema: {
          type: "object",
          properties: {
            count: { type: "number" },
          },
        },
        outputSchema: {
          type: "string",
        },
        metadata: {
          requestKind: "rpc.invoke",
          route: "echo",
        },
      },
      serviceMetadata: { serverUrl: "http://127.0.0.1:8787" },
    });
  });

  it("throws 404 when manifest is missing", async () => {
    const service = new ManifestService(
      async () => null,
      async () => null,
    );

    await expect(
      service.getTool("missing-service", "tool-1"),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("throws 404 when tool is missing", async () => {
    const metadata: ManifestMetadata = {
      serverUrl: "http://127.0.0.1:8788",
    };
    const service = new ManifestService(
      async () => metadata,
      async () => null,
    );

    await expect(
      service.getTool("svc-2", "missing-tool"),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("throws 500 when database read fails", async () => {
    const service = new ManifestService(
      async () => {
        throw new Error("boom");
      },
      async () => null,
    );

    await expect(service.getTool("svc-3", "tool-1")).rejects.toMatchObject({
      statusCode: 500,
    });
  });

  it("throws 500 when tool read fails", async () => {
    const service = new ManifestService(
      async () => ({ serverUrl: "http://localhost" }),
      async () => {
        throw new Error("boom");
      },
    );

    await expect(service.getTool("svc-3", "tool-1")).rejects.toMatchObject({
      statusCode: 500,
    });
  });
});
