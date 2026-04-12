import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db/client";
import { definitions, manifests, tools } from "@/db/schema";
import type { ManifestMetadata, ToolDefinition } from "@/models/manifest.model";
import { ManifestService } from "@/services/manifest.service";
import { computeContentHash } from "@/utils/hash.util";

async function resetManifestTables(): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  await db.run(sql`DROP TABLE IF EXISTS tools`);
  await db.run(sql`DROP TABLE IF EXISTS manifests`);
  await db.run(sql`DROP TABLE IF EXISTS definitions`);
  await db.run(sql`
    CREATE TABLE definitions (
      id text PRIMARY KEY NOT NULL,
      type text NOT NULL,
      content blob NOT NULL,
      hash text NOT NULL
    )
  `);
  await db.run(sql`
    CREATE TABLE manifests (
      id text PRIMARY KEY NOT NULL,
      definition_id text,
      hash text NOT NULL,
      metadata text NOT NULL
      ,FOREIGN KEY (definition_id) REFERENCES definitions(id) ON UPDATE no action ON DELETE cascade
    )
  `);
  await db.run(
    sql`CREATE UNIQUE INDEX manifests_definition_id_unique ON manifests (definition_id)`,
  );
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
      async (serviceName) => (serviceName === "svc-1" ? metadata : null),
      async (serviceName, toolName) =>
        serviceName === "svc-1" && toolName === "tool-1"
          ? toolDefinition
          : null,
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
    const definitionContent = JSON.stringify({
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

    await db.insert(definitions).values({
      id: "def-create",
      type: "foo",
      content: Buffer.from(definitionContent, "utf8"),
      hash: computeContentHash(definitionContent),
    });

    await service.createService("svc-create", "def-create");

    await expect(service.getService("svc-create")).resolves.toEqual({
      name: "svc-create",
      hash: computeContentHash(definitionContent),
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

  it("lists tools with and without name filter", async () => {
    const service = new ManifestService();
    await db.insert(manifests).values({
      id: "svc-tools",
      hash: "hash-tools-1",
      metadata: {
        serverUrl: "http://127.0.0.1:9000",
      },
    });
    await db.insert(manifests).values({
      id: "svc-tools-2",
      hash: "hash-tools-2",
      metadata: {
        serverUrl: "http://127.0.0.1:9001",
      },
    });
    await db.insert(tools).values([
      {
        serviceName: "svc-tools",
        name: "echo",
        metadata: {},
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
      {
        serviceName: "svc-tools-2",
        name: "echo",
        metadata: {},
        inputSchema: { type: "object" },
        outputSchema: { type: "number" },
      },
    ]);

    await expect(service.listTools("echo")).resolves.toEqual([
      {
        serviceName: "svc-tools",
        name: "echo",
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
      {
        serviceName: "svc-tools-2",
        name: "echo",
        inputSchema: { type: "object" },
        outputSchema: { type: "number" },
      },
    ]);

    await expect(service.listTools()).resolves.toEqual([
      {
        serviceName: "svc-tools",
        name: "echo",
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
      {
        serviceName: "svc-tools-2",
        name: "echo",
        inputSchema: { type: "object" },
        outputSchema: { type: "number" },
      },
    ]);
  });

  it("lists services with tools and without metadata", async () => {
    const service = new ManifestService();
    await db.insert(manifests).values([
      {
        id: "svc-1",
        hash: "hash-svc-1",
        metadata: { serverUrl: "http://127.0.0.1:8001" },
      },
      {
        id: "svc-2",
        hash: "hash-svc-2",
        metadata: { serverUrl: "http://127.0.0.1:8002" },
      },
    ]);
    await db.insert(tools).values([
      {
        serviceName: "svc-1",
        name: "echo",
        metadata: { route: "invoke/echo" },
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
      {
        serviceName: "svc-1",
        name: "ping",
        metadata: { route: "invoke/ping" },
        inputSchema: { type: "object" },
        outputSchema: { type: "null" },
      },
    ]);

    await expect(service.listServices()).resolves.toEqual([
      {
        name: "svc-1",
        hash: "hash-svc-1",
        tools: [
          {
            name: "echo",
            inputSchema: { type: "object" },
            outputSchema: { type: "string" },
          },
          {
            name: "ping",
            inputSchema: { type: "object" },
            outputSchema: { type: "null" },
          },
        ],
      },
      {
        name: "svc-2",
        hash: "hash-svc-2",
        tools: [],
      },
    ]);
  });
});
