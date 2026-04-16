import { describe, expect, it } from "vitest";

import type { ManifestMetadata, ToolDefinition } from "@/models/manifest.model";
import {
  isUniqueConstraintViolation,
  ManifestService,
} from "@/services/manifest.service";

describe("manifest.service unit", () => {
  it("loads tool and metadata through injected loaders", async () => {
    const metadata: ManifestMetadata = { serverUrl: "http://127.0.0.1:8787" };
    const toolDefinition: ToolDefinition = {
      name: "tool-1",
      description: "",
      enabled: true,
      metadata: { requestKind: "rpc.invoke", route: "echo" },
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
    };

    const service = new ManifestService(
      async (serviceName) =>
        serviceName === "svc-1" ? { metadata, enabled: true } : null,
      async (serviceName, toolName) =>
        serviceName === "svc-1" && toolName === "tool-1"
          ? toolDefinition
          : null,
    );

    await expect(service.getTool("svc-1", "tool-1")).resolves.toEqual({
      tool: toolDefinition,
      serviceMetadata: metadata,
      serviceEnabled: true,
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
      async () => ({
        metadata: { serverUrl: "http://127.0.0.1:8788" },
        enabled: true,
      }),
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

  it("detects SQLite and Postgres unique-constraint errors", () => {
    expect(
      isUniqueConstraintViolation(
        new Error("UNIQUE constraint failed: manifests.definition_id"),
      ),
    ).toBe(true);

    expect(
      isUniqueConstraintViolation(
        new Error(
          'duplicate key value violates unique constraint "manifests_definition_id_unique"',
        ),
      ),
    ).toBe(true);

    expect(
      isUniqueConstraintViolation({
        code: "SQLITE_CONSTRAINT_UNIQUE",
        message: "driver unique violation",
      }),
    ).toBe(true);
  });

  it("does not mislabel non-unique constraint errors", () => {
    expect(
      isUniqueConstraintViolation(
        new Error("NOT NULL constraint failed: manifests.hash"),
      ),
    ).toBe(false);

    expect(
      isUniqueConstraintViolation(new Error("FOREIGN KEY constraint failed")),
    ).toBe(false);

    expect(
      isUniqueConstraintViolation(new Error("CHECK constraint failed")),
    ).toBe(false);
  });
});
