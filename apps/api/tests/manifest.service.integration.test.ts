import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db/client";
import { manifests, tools } from "@/db/schema";
import type {
  ManifestMetadata,
  ServiceToolDefinition,
} from "@/models/manifest.model";
import { ManifestService } from "@/services/manifest.service";
import { computeContentHash } from "@/utils/hash.util";

async function resetManifestTables(): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  await db.run(sql`DROP TABLE IF EXISTS tools`);
  await db.run(sql`DROP TABLE IF EXISTS services`);
  await db.run(sql`DROP TABLE IF EXISTS definitions`);
  await db.run(sql`
    CREATE TABLE definitions (
      id text PRIMARY KEY NOT NULL,
      type text NOT NULL,
      description text NOT NULL DEFAULT '',
      content blob NOT NULL,
      hash text NOT NULL
    )
  `);
  await db.run(sql`
    CREATE TABLE services (
      id text PRIMARY KEY NOT NULL,
      definition_id text,
      description text NOT NULL DEFAULT '',
      hash text NOT NULL,
      enabled integer NOT NULL DEFAULT 1,
      metadata text NOT NULL
      ,FOREIGN KEY (definition_id) REFERENCES definitions(id) ON UPDATE no action ON DELETE cascade
    )
  `);
  await db.run(
    sql`CREATE UNIQUE INDEX services_definition_id_unique ON services (definition_id)`,
  );
  await db.run(sql`
    CREATE TABLE tools (
      service_id text NOT NULL,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      enabled integer NOT NULL DEFAULT 1,
      input_schema text NOT NULL,
      output_schema text NOT NULL,
      metadata text NOT NULL,
      PRIMARY KEY(service_id, name),
      FOREIGN KEY (service_id) REFERENCES services(id) ON UPDATE no action ON DELETE cascade
    )
  `);
  await db.run(sql`CREATE INDEX tools_name_idx ON tools (name)`);
  await db.run(sql`PRAGMA foreign_keys = ON`);
}

describe.skip("manifest.service integration", () => {
  beforeEach(async () => {
    await resetManifestTables();
  });

  it("loads tool schemas from the tool record", async () => {
    const metadata: ManifestMetadata = {
      serverUrl: "http://127.0.0.1:8787",
    };
    const toolDefinition: ServiceToolDefinition = {
      name: "tool-1",
      description: "",
      enabled: true,
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
      async (serviceName) =>
        serviceName === "svc-1" ? { metadata, enabled: true } : null,
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
      serviceEnabled: true,
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
      async () => ({ metadata, enabled: true }),
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
      async () => ({
        metadata: { serverUrl: "http://localhost" },
        enabled: true,
      }),
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
      description: "",
      enabled: true,
      metadata: {
        serverUrl: "http://127.0.0.1:9001",
      },
      tools: [
        {
          name: "echo",
          description: "",
          enabled: true,
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
      description: "",
      content: Buffer.from(definitionContent, "utf8"),
      hash: computeContentHash(definitionContent),
    });

    await service.createService("svc-create", "def-create");

    await expect(service.getService("svc-create")).resolves.toEqual({
      name: "svc-create",
      description: "",
      hash: computeContentHash(definitionContent),
      enabled: true,
      metadata: {
        serverUrl: "http://127.0.0.1:9001",
      },
    });

    await expect(service.listTools("svc-create")).resolves.toEqual([
      {
        name: "echo",
        description: "",
        enabled: true,
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
    ]);
  });

  it("lists tools with and without name filter", async () => {
    const service = new ManifestService();
    await db.insert(manifests).values({
      id: "svc-tools-list",
      description: "",
      hash: "hash-tools-list",
      metadata: {
        serverUrl: "http://127.0.0.1:9002",
      },
    });
    await db.insert(tools).values([
      {
        serviceName: "svc-tools-list",
        name: "echo",
        description: "",
        metadata: { route: "invoke/echo" },
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
      {
        serviceName: "svc-tools-list",
        name: "sum",
        description: "",
        metadata: { route: "invoke/sum" },
        inputSchema: { type: "object" },
        outputSchema: { type: "number" },
      },
    ]);

    await expect(service.listTools("svc-tools-list")).resolves.toEqual([
      {
        name: "echo",
        description: "",
        enabled: true,
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
      {
        name: "sum",
        description: "",
        enabled: true,
        inputSchema: { type: "object" },
        outputSchema: { type: "number" },
      },
    ]);

    await expect(service.listTools("svc-tools-list", " eC ")).resolves.toEqual([
      {
        name: "echo",
        description: "",
        enabled: true,
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
    ]);

    await expect(
      service.listTools("svc-tools-list", "missing"),
    ).resolves.toEqual([]);

    await expect(service.listTools("svc-missing")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("discovers tools with and without name filter", async () => {
    const service = new ManifestService();
    await db.insert(manifests).values({
      id: "svc-tools",
      description: "",
      hash: "hash-tools-1",
      metadata: {
        serverUrl: "http://127.0.0.1:9000",
      },
    });
    await db.insert(manifests).values({
      id: "svc-tools-2",
      description: "",
      hash: "hash-tools-2",
      metadata: {
        serverUrl: "http://127.0.0.1:9001",
      },
    });
    await db.insert(tools).values([
      {
        serviceName: "svc-tools",
        name: "echo",
        description: "",
        metadata: {},
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
      {
        serviceName: "svc-tools-2",
        name: "echo",
        description: "",
        metadata: {},
        inputSchema: { type: "object" },
        outputSchema: { type: "number" },
      },
    ]);

    await expect(service.discoverTools("echo")).resolves.toEqual([
      {
        serviceName: "svc-tools",
        name: "echo",
        description: "",
        enabled: true,
        serviceDescription: "",
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
      {
        serviceName: "svc-tools-2",
        name: "echo",
        description: "",
        enabled: true,
        serviceDescription: "",
        inputSchema: { type: "object" },
        outputSchema: { type: "number" },
      },
    ]);

    await expect(service.discoverTools("")).resolves.toEqual([
      {
        serviceName: "svc-tools",
        name: "echo",
        description: "",
        enabled: true,
        serviceDescription: "",
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
      {
        serviceName: "svc-tools-2",
        name: "echo",
        description: "",
        enabled: true,
        serviceDescription: "",
        inputSchema: { type: "object" },
        outputSchema: { type: "number" },
      },
    ]);

    await expect(service.discoverTools("tools-2")).resolves.toEqual([
      {
        serviceName: "svc-tools-2",
        name: "echo",
        description: "",
        enabled: true,
        serviceDescription: "",
        inputSchema: { type: "object" },
        outputSchema: { type: "number" },
      },
    ]);
  });

  it("lists services without tools and supports query filtering", async () => {
    const service = new ManifestService();
    await db.insert(manifests).values([
      {
        id: "svc-1",
        description: "",
        hash: "hash-svc-1",
        metadata: { serverUrl: "http://127.0.0.1:8001" },
      },
      {
        id: "svc-2",
        description: "",
        hash: "hash-svc-2",
        metadata: { serverUrl: "http://127.0.0.1:8002" },
      },
    ]);
    await db.insert(tools).values([
      {
        serviceName: "svc-1",
        name: "echo",
        description: "",
        metadata: { route: "invoke/echo" },
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
      {
        serviceName: "svc-1",
        name: "ping",
        description: "",
        metadata: { route: "invoke/ping" },
        inputSchema: { type: "object" },
        outputSchema: { type: "null" },
      },
    ]);

    await expect(service.listServices()).resolves.toEqual([
      {
        name: "svc-1",
        description: "",
        hash: "hash-svc-1",
        enabled: true,
      },
      {
        name: "svc-2",
        description: "",
        hash: "hash-svc-2",
        enabled: true,
      },
    ]);

    await expect(service.listServices("vc-2")).resolves.toEqual([
      {
        name: "svc-2",
        description: "",
        hash: "hash-svc-2",
        enabled: true,
      },
    ]);
  });

  it("discovers services by query in service name", async () => {
    const service = new ManifestService();
    await db.insert(manifests).values([
      {
        id: "svc-alpha",
        description: "",
        hash: "hash-svc-alpha",
        metadata: { serverUrl: "http://127.0.0.1:8101" },
      },
      {
        id: "svc-beta",
        description: "",
        hash: "hash-svc-beta",
        metadata: { serverUrl: "http://127.0.0.1:8102" },
      },
    ]);

    await expect(service.discoverServices("alp")).resolves.toEqual([
      {
        name: "svc-alpha",
        description: "",
        hash: "hash-svc-alpha",
        enabled: true,
      },
    ]);

    await expect(service.discoverServices("")).resolves.toEqual([
      {
        name: "svc-alpha",
        description: "",
        hash: "hash-svc-alpha",
        enabled: true,
      },
      {
        name: "svc-beta",
        description: "",
        hash: "hash-svc-beta",
        enabled: true,
      },
    ]);
  });

  it("does not update service when hashes already match", async () => {
    const service = new ManifestService();
    const definitionContent = JSON.stringify({
      name: "svc-same",
      description: "",
      enabled: true,
      metadata: {
        serverUrl: "http://127.0.0.1:9011",
      },
      tools: [],
    });
    const hash = computeContentHash(definitionContent);

    await db.insert(definitions).values({
      id: "def-same",
      type: "foo",
      description: "",
      content: Buffer.from(definitionContent, "utf8"),
      hash,
    });
    await db.insert(manifests).values({
      id: "svc-same",
      definitionId: "def-same",
      description: "",
      hash,
      metadata: {
        serverUrl: "http://127.0.0.1:9011",
      },
    });

    await expect(service.updateService("svc-same", "def-same")).resolves.toBe(
      false,
    );
    await expect(service.getService("svc-same")).resolves.toMatchObject({
      name: "svc-same",
      description: "",
      hash,
      enabled: true,
      metadata: {
        serverUrl: "http://127.0.0.1:9011",
      },
    });

    await expect(service.listTools("svc-same")).resolves.toEqual([]);
  });

  it("updates service manifest and tools when hashes differ", async () => {
    const service = new ManifestService();
    const oldDefinitionContent = JSON.stringify({
      name: "svc-update",
      description: "",
      enabled: true,
      metadata: {
        serverUrl: "http://127.0.0.1:9012",
      },
      tools: [
        {
          name: "old-tool",
          description: "",
          enabled: true,
          metadata: {
            route: "invoke/old-tool",
          },
          inputSchema: { type: "object" },
          outputSchema: { type: "string" },
        },
      ],
    });
    const newDefinitionContent = JSON.stringify({
      name: "svc-update",
      description: "",
      enabled: true,
      metadata: {
        serverUrl: "http://127.0.0.1:9013",
      },
      tools: [
        {
          name: "new-tool",
          description: "",
          enabled: true,
          metadata: {
            route: "invoke/new-tool",
          },
          inputSchema: {
            type: "object",
            properties: {
              value: { type: "number" },
            },
          },
          outputSchema: { type: "number" },
        },
      ],
    });

    await db.insert(definitions).values([
      {
        id: "def-old",
        type: "foo",
        description: "",
        content: Buffer.from(oldDefinitionContent, "utf8"),
        hash: computeContentHash(oldDefinitionContent),
      },
      {
        id: "def-new",
        type: "foo",
        description: "",
        content: Buffer.from(newDefinitionContent, "utf8"),
        hash: computeContentHash(newDefinitionContent),
      },
    ]);

    await service.createService("svc-update", "def-old");

    await expect(service.updateService("svc-update", "def-new")).resolves.toBe(
      true,
    );

    await expect(service.getService("svc-update")).resolves.toEqual({
      name: "svc-update",
      description: "",
      hash: computeContentHash(newDefinitionContent),
      enabled: true,
      metadata: {
        serverUrl: "http://127.0.0.1:9013",
      },
    });

    await expect(service.listTools("svc-update")).resolves.toEqual([
      {
        name: "new-tool",
        description: "",
        enabled: true,
        inputSchema: {
          type: "object",
          properties: {
            value: { type: "number" },
          },
        },
        outputSchema: { type: "number" },
      },
    ]);

    await expect(
      service.getTool("svc-update", "new-tool"),
    ).resolves.toMatchObject({
      tool: {
        name: "new-tool",
        description: "",
        enabled: true,
        metadata: {
          route: "invoke/new-tool",
        },
        inputSchema: {
          type: "object",
          properties: {
            value: { type: "number" },
          },
        },
        outputSchema: { type: "number" },
      },
      serviceEnabled: true,
    });
  });

  it("toggles service and tool enabled flags and reports effective tool status", async () => {
    const service = new ManifestService();

    await db.insert(manifests).values({
      id: "svc-enabled-toggle",
      description: "",
      hash: "hash-enabled-toggle",
      metadata: { serverUrl: "http://127.0.0.1:9101" },
    });
    await db.insert(tools).values({
      serviceName: "svc-enabled-toggle",
      name: "echo",
      description: "",
      metadata: {},
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
    });

    await expect(service.listTools("svc-enabled-toggle")).resolves.toEqual([
      {
        name: "echo",
        description: "",
        enabled: true,
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
    ]);

    await service.setToolEnabled("svc-enabled-toggle", "echo", false);

    await expect(service.listTools("svc-enabled-toggle")).resolves.toEqual([
      {
        name: "echo",
        description: "",
        enabled: false,
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
    ]);

    await service.setToolEnabled("svc-enabled-toggle", "echo", true);
    await service.setServiceEnabled("svc-enabled-toggle", false);

    await expect(service.getService("svc-enabled-toggle")).resolves.toEqual({
      name: "svc-enabled-toggle",
      description: "",
      hash: "hash-enabled-toggle",
      enabled: false,
      metadata: { serverUrl: "http://127.0.0.1:9101" },
    });

    await expect(service.listTools("svc-enabled-toggle")).resolves.toEqual([
      {
        name: "echo",
        description: "",
        enabled: false,
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
    ]);

    await expect(service.discoverTools("svc-enabled-toggle")).resolves.toEqual(
      [],
    );

    await expect(
      service.discoverTools("svc-enabled-toggle", undefined, null),
    ).resolves.toEqual([
      {
        serviceName: "svc-enabled-toggle",
        name: "echo",
        description: "",
        enabled: false,
        serviceDescription: "",
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
    ]);

    await expect(
      service.getTool("svc-enabled-toggle", "echo"),
    ).resolves.toMatchObject({
      tool: {
        name: "echo",
        enabled: true,
      },
      serviceEnabled: false,
    });
  });
});
