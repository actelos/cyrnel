import { EventEmitter } from "node:events";

import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db/client";
import { manifests, tools } from "@/db/schema";
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
    this.emit("sent", message);
    return true;
  }
}

async function waitForMessageCount(
  channel: TestDiscoverChannel,
  count: number,
): Promise<void> {
  const maxTurns = 5_000;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (channel.sent.length >= count) {
      return;
    }

    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  throw new Error(
    `Timed out waiting for ${count} message(s); received ${channel.sent.length}.`,
  );
}

async function resetDiscoverTables(): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  await db.run(sql`DROP TABLE IF EXISTS tools`);
  await db.run(sql`DROP TABLE IF EXISTS manifests`);
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
    CREATE TABLE manifests (
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
    sql`CREATE UNIQUE INDEX manifests_definition_id_unique ON manifests (definition_id)`,
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
      FOREIGN KEY (service_id) REFERENCES manifests(id) ON UPDATE no action ON DELETE cascade
    )
  `);
  await db.run(sql`CREATE INDEX tools_name_idx ON tools (name)`);
  await db.run(sql`PRAGMA foreign_keys = ON`);
}

async function seedDiscoverFixtures(): Promise<void> {
  await db.insert(manifests).values([
    {
      id: "svc-alpha",
      description: "",
      hash: "hash-alpha",
      metadata: { serverUrl: "http://127.0.0.1:8301" },
    },
    {
      id: "svc-beta",
      description: "",
      hash: "hash-beta",
      metadata: { serverUrl: "http://127.0.0.1:8302" },
    },
    {
      id: "svc-gamma",
      description: "",
      hash: "hash-gamma",
      metadata: { serverUrl: "http://127.0.0.1:8303" },
    },
  ]);

  await db.insert(tools).values([
    {
      serviceName: "svc-alpha",
      name: "echo",
      description: "",
      metadata: { route: "invoke/echo" },
      inputSchema: {
        type: "object",
        properties: { input: { type: "string" } },
      },
      outputSchema: { type: "string" },
    },
    {
      serviceName: "svc-alpha",
      name: "list-users",
      description: "",
      metadata: { route: "invoke/list-users" },
      inputSchema: { type: "object" },
      outputSchema: {
        type: "array",
        items: { type: "string" },
      },
    },
    {
      serviceName: "svc-beta",
      name: "echo-plus",
      description: "",
      metadata: { route: "invoke/echo-plus" },
      inputSchema: {
        type: "object",
        properties: { input: { type: "string" }, times: { type: "number" } },
      },
      outputSchema: { type: "string" },
    },
    {
      serviceName: "svc-beta",
      name: "sum",
      description: "",
      metadata: { route: "invoke/sum" },
      inputSchema: {
        type: "object",
        properties: {
          values: {
            type: "array",
            items: { type: "number" },
          },
        },
      },
      outputSchema: { type: "number" },
    },
    {
      serviceName: "svc-gamma",
      name: "ping",
      description: "",
      metadata: { route: "invoke/ping" },
      inputSchema: { type: "object" },
      outputSchema: { type: "null" },
    },
  ]);
}

describe("discover.service integration", () => {
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    await resetDiscoverTables();
  });

  afterEach(() => {
    while (disposers.length > 0) {
      const dispose = disposers.pop();
      dispose?.();
    }
  });

  it("discovers all tools with blank query and returns stored schemas", async () => {
    await seedDiscoverFixtures();

    const channel = new TestDiscoverChannel();
    const dispose = createDiscoverMessageSystem(channel);
    disposers.push(dispose);

    channel.emit("message", {
      type: "discover.tools",
      requestId: "req-tools-all",
      query: "   ",
    });

    await waitForMessageCount(channel, 1);

    expect(channel.sent).toEqual([
      {
        type: "tools.response",
        requestId: "req-tools-all",
        tools: [
          {
            serviceName: "svc-alpha",
            name: "echo",
            description: "",
            enabled: true,
            serviceDescription: "",
            inputSchema: {
              type: "object",
              properties: { input: { type: "string" } },
            },
            outputSchema: { type: "string" },
          },
          {
            serviceName: "svc-alpha",
            name: "list-users",
            description: "",
            enabled: true,
            serviceDescription: "",
            inputSchema: { type: "object" },
            outputSchema: {
              type: "array",
              items: { type: "string" },
            },
          },
          {
            serviceName: "svc-beta",
            name: "echo-plus",
            description: "",
            enabled: true,
            serviceDescription: "",
            inputSchema: {
              type: "object",
              properties: {
                input: { type: "string" },
                times: { type: "number" },
              },
            },
            outputSchema: { type: "string" },
          },
          {
            serviceName: "svc-beta",
            name: "sum",
            description: "",
            enabled: true,
            serviceDescription: "",
            inputSchema: {
              type: "object",
              properties: {
                values: {
                  type: "array",
                  items: { type: "number" },
                },
              },
            },
            outputSchema: { type: "number" },
          },
          {
            serviceName: "svc-gamma",
            name: "ping",
            description: "",
            enabled: true,
            serviceDescription: "",
            inputSchema: { type: "object" },
            outputSchema: { type: "null" },
          },
        ],
      },
    ]);
  });

  it("filters tools by tool-name query with case-insensitive matching", async () => {
    await seedDiscoverFixtures();

    const channel = new TestDiscoverChannel();
    const dispose = createDiscoverMessageSystem(channel);
    disposers.push(dispose);

    channel.emit("message", {
      type: "discover.tools",
      requestId: "req-tools-name-filter",
      query: " EcHo ",
    });

    await waitForMessageCount(channel, 1);

    expect(channel.sent).toEqual([
      {
        type: "tools.response",
        requestId: "req-tools-name-filter",
        tools: [
          {
            serviceName: "svc-alpha",
            name: "echo",
            description: "",
            enabled: true,
            serviceDescription: "",
            inputSchema: {
              type: "object",
              properties: { input: { type: "string" } },
            },
            outputSchema: { type: "string" },
          },
          {
            serviceName: "svc-beta",
            name: "echo-plus",
            description: "",
            enabled: true,
            serviceDescription: "",
            inputSchema: {
              type: "object",
              properties: {
                input: { type: "string" },
                times: { type: "number" },
              },
            },
            outputSchema: { type: "string" },
          },
        ],
      },
    ]);
  });

  it("filters tools by service-name query and returns exact stored records", async () => {
    await seedDiscoverFixtures();

    const channel = new TestDiscoverChannel();
    const dispose = createDiscoverMessageSystem(channel);
    disposers.push(dispose);

    channel.emit("message", {
      type: "discover.tools",
      requestId: "req-tools-service-filter",
      query: "BETA",
    });

    await waitForMessageCount(channel, 1);

    expect(channel.sent).toEqual([
      {
        type: "tools.response",
        requestId: "req-tools-service-filter",
        tools: [
          {
            serviceName: "svc-beta",
            name: "echo-plus",
            description: "",
            enabled: true,
            serviceDescription: "",
            inputSchema: {
              type: "object",
              properties: {
                input: { type: "string" },
                times: { type: "number" },
              },
            },
            outputSchema: { type: "string" },
          },
          {
            serviceName: "svc-beta",
            name: "sum",
            description: "",
            enabled: true,
            serviceDescription: "",
            inputSchema: {
              type: "object",
              properties: {
                values: {
                  type: "array",
                  items: { type: "number" },
                },
              },
            },
            outputSchema: { type: "number" },
          },
        ],
      },
    ]);
  });

  it("returns empty tool results when query matches nothing", async () => {
    await seedDiscoverFixtures();

    const channel = new TestDiscoverChannel();
    const dispose = createDiscoverMessageSystem(channel);
    disposers.push(dispose);

    channel.emit("message", {
      type: "discover.tools",
      requestId: "req-tools-empty",
      query: "does-not-exist",
    });

    await waitForMessageCount(channel, 1);

    expect(channel.sent).toEqual([
      {
        type: "tools.response",
        requestId: "req-tools-empty",
        tools: [],
      },
    ]);
  });

  it("discovers all services", async () => {
    await seedDiscoverFixtures();

    const channel = new TestDiscoverChannel();
    const dispose = createDiscoverMessageSystem(channel);
    disposers.push(dispose);

    channel.emit("message", {
      type: "discover.services",
      requestId: "req-services-all",
      query: "",
    });

    await waitForMessageCount(channel, 1);

    expect(channel.sent).toEqual([
      {
        type: "services.response",
        requestId: "req-services-all",
        services: [
          {
            name: "svc-alpha",
            description: "",
            hash: "hash-alpha",
            enabled: true,
          },
          {
            name: "svc-beta",
            description: "",
            hash: "hash-beta",
            enabled: true,
          },
          {
            name: "svc-gamma",
            description: "",
            hash: "hash-gamma",
            enabled: true,
          },
        ],
      },
    ]);
  });

  it("filters services by query (trimmed and case-insensitive)", async () => {
    await seedDiscoverFixtures();

    const channel = new TestDiscoverChannel();
    const dispose = createDiscoverMessageSystem(channel);
    disposers.push(dispose);

    channel.emit("message", {
      type: "discover.services",
      requestId: "req-services-filter",
      query: "  BeTa ",
    });

    await waitForMessageCount(channel, 1);

    expect(channel.sent).toEqual([
      {
        type: "services.response",
        requestId: "req-services-filter",
        services: [
          {
            name: "svc-beta",
            description: "",
            hash: "hash-beta",
            enabled: true,
          },
        ],
      },
    ]);
  });

  it("returns empty service results when query matches nothing", async () => {
    await seedDiscoverFixtures();

    const channel = new TestDiscoverChannel();
    const dispose = createDiscoverMessageSystem(channel);
    disposers.push(dispose);

    channel.emit("message", {
      type: "discover.services",
      requestId: "req-services-empty",
      query: "nope",
    });

    await waitForMessageCount(channel, 1);

    expect(channel.sent).toEqual([
      {
        type: "services.response",
        requestId: "req-services-empty",
        services: [],
      },
    ]);
  });

  it("defaults discover.tools enabled filter to true", async () => {
    await seedDiscoverFixtures();

    await db
      .update(manifests)
      .set({ enabled: false })
      .where(sql`${manifests.id} = 'svc-beta'`);
    await db
      .update(tools)
      .set({ enabled: false })
      .where(
        sql`${tools.serviceName} = 'svc-alpha' AND ${tools.name} = 'list-users'`,
      );

    const channel = new TestDiscoverChannel();
    const dispose = createDiscoverMessageSystem(channel);
    disposers.push(dispose);

    channel.emit("message", {
      type: "discover.tools",
      requestId: "req-tools-enabled-default",
      query: "",
    });

    await waitForMessageCount(channel, 1);

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toMatchObject({
      type: "tools.response",
      requestId: "req-tools-enabled-default",
    });

    const response = channel.sent[0];
    if (response.type !== "tools.response") {
      throw new Error("Unexpected response type");
    }

    expect(
      response.tools.map((item) => `${item.serviceName}/${item.name}`),
    ).toEqual(["svc-alpha/echo", "svc-gamma/ping"]);
    expect(response.tools.every((item) => item.enabled)).toBe(true);
  });

  it("returns enabled and disabled items when enabled is null", async () => {
    await seedDiscoverFixtures();

    await db
      .update(manifests)
      .set({ enabled: false })
      .where(sql`${manifests.id} = 'svc-beta'`);
    await db
      .update(tools)
      .set({ enabled: false })
      .where(
        sql`${tools.serviceName} = 'svc-alpha' AND ${tools.name} = 'list-users'`,
      );

    const channel = new TestDiscoverChannel();
    const dispose = createDiscoverMessageSystem(channel);
    disposers.push(dispose);

    channel.emit("message", {
      type: "discover.tools",
      requestId: "req-tools-enabled-null",
      query: "",
      enabled: null,
    });

    channel.emit("message", {
      type: "discover.services",
      requestId: "req-services-enabled-null",
      query: "",
      enabled: null,
    });

    await waitForMessageCount(channel, 2);

    const toolsResponse = channel.sent.find(
      (message) => message.type === "tools.response",
    );
    const servicesResponse = channel.sent.find(
      (message) => message.type === "services.response",
    );

    expect(toolsResponse).toBeDefined();
    expect(servicesResponse).toBeDefined();

    if (!toolsResponse || toolsResponse.type !== "tools.response") {
      throw new Error("tools.response not found");
    }

    if (!servicesResponse || servicesResponse.type !== "services.response") {
      throw new Error("services.response not found");
    }

    expect(
      toolsResponse.tools.map((item) => ({
        key: `${item.serviceName}/${item.name}`,
        enabled: item.enabled,
      })),
    ).toEqual([
      { key: "svc-alpha/echo", enabled: true },
      { key: "svc-alpha/list-users", enabled: false },
      { key: "svc-beta/echo-plus", enabled: false },
      { key: "svc-beta/sum", enabled: false },
      { key: "svc-gamma/ping", enabled: true },
    ]);

    expect(
      servicesResponse.services.map((item) => ({
        name: item.name,
        enabled: item.enabled,
      })),
    ).toEqual([
      { name: "svc-alpha", enabled: true },
      { name: "svc-beta", enabled: false },
      { name: "svc-gamma", enabled: true },
    ]);
  });

  it("sends tools.error when database query for tools fails", async () => {
    await seedDiscoverFixtures();

    const channel = new TestDiscoverChannel();
    const dispose = createDiscoverMessageSystem(channel);
    disposers.push(dispose);

    await db.run(sql`DROP TABLE tools`);

    channel.emit("message", {
      type: "discover.tools",
      requestId: "req-tools-db-error",
      query: "echo",
    });

    await waitForMessageCount(channel, 1);

    expect(channel.sent).toEqual([
      {
        type: "tools.error",
        requestId: "req-tools-db-error",
        message: "Failed to discover tools.",
      },
    ]);
  });

  it("sends services.error when database query for services fails", async () => {
    await seedDiscoverFixtures();

    const channel = new TestDiscoverChannel();
    const dispose = createDiscoverMessageSystem(channel);
    disposers.push(dispose);

    await db.run(sql`DROP TABLE manifests`);

    channel.emit("message", {
      type: "discover.services",
      requestId: "req-services-db-error",
      query: "svc",
    });

    await waitForMessageCount(channel, 1);

    expect(channel.sent).toEqual([
      {
        type: "services.error",
        requestId: "req-services-db-error",
        message: "Failed to list service manifests.",
      },
    ]);
  });
});
