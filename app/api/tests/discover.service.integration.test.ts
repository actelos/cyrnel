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

async function seedDiscoverFixtures(): Promise<void> {
  await db.insert(manifests).values([
    {
      id: "svc-alpha",
      hash: "hash-alpha",
      metadata: { serverUrl: "http://127.0.0.1:8301" },
    },
    {
      id: "svc-beta",
      hash: "hash-beta",
      metadata: { serverUrl: "http://127.0.0.1:8302" },
    },
    {
      id: "svc-gamma",
      hash: "hash-gamma",
      metadata: { serverUrl: "http://127.0.0.1:8303" },
    },
  ]);

  await db.insert(tools).values([
    {
      serviceName: "svc-alpha",
      name: "echo",
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
            inputSchema: {
              type: "object",
              properties: { input: { type: "string" } },
            },
            outputSchema: { type: "string" },
          },
          {
            serviceName: "svc-alpha",
            name: "list-users",
            inputSchema: { type: "object" },
            outputSchema: {
              type: "array",
              items: { type: "string" },
            },
          },
          {
            serviceName: "svc-beta",
            name: "echo-plus",
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
            inputSchema: {
              type: "object",
              properties: { input: { type: "string" } },
            },
            outputSchema: { type: "string" },
          },
          {
            serviceName: "svc-beta",
            name: "echo-plus",
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

  it("discovers all services and includes each service tool list", async () => {
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
            hash: "hash-alpha",
            tools: [
              {
                name: "echo",
                inputSchema: {
                  type: "object",
                  properties: { input: { type: "string" } },
                },
                outputSchema: { type: "string" },
              },
              {
                name: "list-users",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "array",
                  items: { type: "string" },
                },
              },
            ],
          },
          {
            name: "svc-beta",
            hash: "hash-beta",
            tools: [
              {
                name: "echo-plus",
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
                name: "sum",
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
          {
            name: "svc-gamma",
            hash: "hash-gamma",
            tools: [
              {
                name: "ping",
                inputSchema: { type: "object" },
                outputSchema: { type: "null" },
              },
            ],
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
            hash: "hash-beta",
            tools: [
              {
                name: "echo-plus",
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
                name: "sum",
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
