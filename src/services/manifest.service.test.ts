import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db/client";
import { manifests, tools } from "@/db/schema";
import type { ManifestMetadata, ToolDefinition } from "@/models/manifest.model";
import { ManifestService } from "@/services/manifest.service";

async function resetManifestTables(): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  await db.run(sql`DROP TABLE IF EXISTS tools`);
  await db.run(sql`DROP TABLE IF EXISTS manifests`);
  await db.run(sql`
    CREATE TABLE manifests (
      id text PRIMARY KEY NOT NULL,
      metadata text NOT NULL
    )
  `);
  await db.run(sql`
    CREATE TABLE tools (
      service_id text NOT NULL,
      name text NOT NULL,
      input_schema text NOT NULL,
      output_schema text NOT NULL,
      metadata text NOT NULL,
      PRIMARY KEY(service_id, name),
      FOREIGN KEY (service_id) REFERENCES manifests(id) ON UPDATE no action ON DELETE cascade
    )
  `);
  await db.run(sql`CREATE INDEX tools_name_idx ON tools (name)`);
  await db.run(sql`PRAGMA foreign_keys = ON`);
}

describe("manifest.service", () => {
  beforeEach(async () => {
    await resetManifestTables();
  });

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

  it("creates a service manifest and persists tools", async () => {
    const service = new ManifestService();

    await service.createService(
      "svc-create",
      JSON.stringify({
        metadata: {
          serverUrl: "http://127.0.0.1:9001",
        },
        tools: [
          {
            name: "echo",
            metadata: {
              route: "invoke/echo",
            },
            inputSchema: {
              type: "object",
              properties: {
                input: { type: "string" },
              },
            },
            outputSchema: {
              type: "string",
            },
          },
        ],
      }),
    );

    await expect(service.getService("svc-create")).resolves.toEqual({
      name: "svc-create",
      metadata: {
        serverUrl: "http://127.0.0.1:9001",
      },
      tools: [
        {
          name: "echo",
          metadata: {
            route: "invoke/echo",
          },
          inputSchema: {
            type: "object",
            properties: {
              input: { type: "string" },
            },
          },
          outputSchema: {
            type: "string",
          },
        },
      ],
    });
  });

  it("updates a service by fully replacing tools", async () => {
    const service = new ManifestService();
    await db.insert(manifests).values({
      id: "svc-update",
      metadata: {
        serverUrl: "http://127.0.0.1:9000",
      },
    });
    await db.insert(tools).values([
      {
        serviceId: "svc-update",
        name: "old-tool",
        metadata: {},
        inputSchema: { type: "object" },
        outputSchema: { type: "null" },
      },
    ]);

    await service.updateService(
      "svc-update",
      JSON.stringify({
        metadata: {
          serverUrl: "http://127.0.0.1:9002",
        },
        tools: [
          {
            name: "new-tool",
            metadata: {
              route: "invoke/new-tool",
            },
            inputSchema: {
              type: "object",
              properties: {
                count: { type: "number" },
              },
            },
            outputSchema: {
              type: "number",
            },
          },
        ],
      }),
    );

    await expect(service.getService("svc-update")).resolves.toEqual({
      name: "svc-update",
      metadata: {
        serverUrl: "http://127.0.0.1:9002",
      },
      tools: [
        {
          name: "new-tool",
          metadata: {
            route: "invoke/new-tool",
          },
          inputSchema: {
            type: "object",
            properties: {
              count: { type: "number" },
            },
          },
          outputSchema: {
            type: "number",
          },
        },
      ],
    });
  });
});
