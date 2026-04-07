import { describe, expect, it } from "vitest";

import type { ServiceManifest } from "@/models/manifest.model";
import { ManifestService } from "@/services/manifest.service";

describe("manifest.service", () => {
  it("loads tool schemas from the manifest record", async () => {
    const manifest: ServiceManifest = {
      metadata: {
        serverUrl: "http://127.0.0.1:8787",
      },
      tools: [
        {
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
        },
      ],
    };
    const service = new ManifestService(async (serviceId) => {
      return serviceId === "svc-1" ? manifest : null;
    });

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
      serviceMetadata: {
        serverUrl: "http://127.0.0.1:8787",
      },
    });
  });

  it("throws 404 when manifest is missing", async () => {
    const service = new ManifestService(async () => null);

    await expect(service.getTool("missing-service", "tool-1")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("throws 404 when tool is missing", async () => {
    const manifest: ServiceManifest = {
      metadata: {
        serverUrl: "http://127.0.0.1:8788",
      },
      tools: [
        {
          name: "tool-2",
          metadata: {
            route: "invoke/tool-2",
            kind: "rpc.invoke",
          },
          inputSchema: {
            type: "object",
          },
          outputSchema: {
            type: "number",
          },
        },
      ],
    };
    const service = new ManifestService(async () => manifest);

    await expect(service.getTool("svc-2", "missing-tool")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("throws 500 when database read fails", async () => {
    const service = new ManifestService(async () => {
      throw new Error("boom");
    });

    await expect(service.getTool("svc-3", "tool-1")).rejects.toMatchObject({
      statusCode: 500,
    });
  });
});
