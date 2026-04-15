import { describe, expect, it } from "vitest";

import type { ManifestMetadata, ToolDefinition } from "@/models/manifest.model";
import { ManifestService } from "@/services/manifest.service";

describe("manifest.service unit", () => {
  it("loads tool and metadata through injected loaders", async () => {
    const metadata: ManifestMetadata = { serverUrl: "http://127.0.0.1:8787" };
    const toolDefinition: ToolDefinition = {
      name: "tool-1",
      description: "",
      metadata: { requestKind: "rpc.invoke", route: "echo" },
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
    };

    const service = new ManifestService(
      async (serviceName) => (serviceName === "svc-1" ? metadata : null),
      async (serviceName, toolName) =>
        serviceName === "svc-1" && toolName === "tool-1"
          ? toolDefinition
          : null,
    );

    await expect(service.getTool("svc-1", "tool-1")).resolves.toEqual({
      tool: toolDefinition,
      serviceMetadata: metadata,
    });
  });

  it("returns 404 when manifest is missing", async () => {
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

  it("returns 404 when tool is missing", async () => {
    const service = new ManifestService(
      async () => ({ serverUrl: "http://127.0.0.1:8788" }),
      async () => null,
    );

    await expect(
      service.getTool("svc-2", "missing-tool"),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("validates empty inputs before attempting any database-backed lookup", async () => {
    const service = new ManifestService(
      async () => {
        throw new Error("loader should not be called");
      },
      async () => {
        throw new Error("loader should not be called");
      },
    );

    await expect(service.getTool("   ", "tool")).rejects.toMatchObject({
      statusCode: 400,
    });

    await expect(service.getTool("svc", "   ")).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
