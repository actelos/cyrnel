import { EventEmitter } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db/client";
import { manifests, tools } from "@/db/schema";
import type { InvokeResponse } from "@/models/invoke.model";
import { AdapterModule } from "@/modules/adapter.module";
import {
  createProcessMessageSystem,
  type ProcessMessageChannel,
} from "@/services/invoke.service";
import { ManifestService } from "@/services/manifest.service";

class TestProcessChannel extends EventEmitter implements ProcessMessageChannel {
  readonly sent: InvokeResponse[] = [];

  send(message: InvokeResponse): boolean {
    this.sent.push(message);
    this.emit("sent", message);
    return true;
  }
}

async function waitForMessageCount(
  channel: TestProcessChannel,
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

interface StartedTestServer {
  readonly baseUrl: string;
  readonly calls: Array<{ toolName: string; body: unknown }>;
  close: () => Promise<void>;
}

async function startTestServer(): Promise<StartedTestServer> {
  const calls: Array<{ toolName: string; body: unknown }> = [];

  const server = createServer((req, res) => {
    void handleServerRequest(req, res, calls);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine test server address.");
  }

  const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;

  return {
    baseUrl,
    calls,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

async function handleServerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  calls: Array<{ toolName: string; body: unknown }>,
): Promise<void> {
  if (!req.url || req.method !== "POST") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Not found" }));
    return;
  }

  const toolName = decodeURIComponent(req.url.replace(/^\//, ""));
  const body = await readJsonBody(req);
  calls.push({ toolName, body });

  if (toolName === "echo") {
    if (!isObject(body) || typeof body.input !== "string") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "input must be a string" }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ output: body.input }));
    return;
  }

  if (toolName === "broken-output") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ output: "not-a-number" }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: `Tool '${toolName}' does not exist` }));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on("end", () => resolve());
    req.on("error", reject);
  });

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

function isObject(
  value: unknown,
): value is Record<string, string | number | boolean | null> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function resetManifestsTable(): Promise<void> {
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

describe("invoke echo integration", () => {
  let server: StartedTestServer;

  beforeEach(async () => {
    await resetManifestsTable();
    server = await startTestServer();

    await db.insert(manifests).values({
      id: "test-service",
      description: "",
      hash: "test-manifest-hash",
      metadata: {
        serverUrl: server.baseUrl,
      },
    });

    await db.insert(tools).values([
      {
        serviceName: "test-service",
        name: "echo",
        description: "",
        metadata: {},
        inputSchema: {
          type: "object",
          required: ["input"],
          properties: {
            input: {
              type: "string",
            },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: "string",
        },
      },
      {
        serviceName: "test-service",
        name: "broken-output",
        description: "",
        metadata: {},
        inputSchema: {
          type: "object",
          additionalProperties: true,
        },
        outputSchema: {
          type: "number",
        },
      },
    ]);
  });

  afterEach(async () => {
    await db.delete(manifests);
    await server.close();
  });

  it("sends invoke.tool to echo tool and receives echoed output", async () => {
    const adapter = new AdapterModule({ baseUrl: server.baseUrl });
    const channel = new TestProcessChannel();
    const manifestService = new ManifestService();

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", {
      type: "invoke.tool",
      requestId: "req-echo",
      serviceName: "test-service",
      toolName: "echo",
      parameters: {
        input: "hello echo",
      },
    });

    await waitForMessageCount(channel, 1);

    expect(channel.sent).toEqual([
      {
        type: "invoke.response",
        requestId: "req-echo",
        output: "hello echo",
      },
    ]);

    expect(server.calls).toEqual([
      {
        toolName: "echo",
        body: {
          input: "hello echo",
        },
      },
    ]);
  });

  it("returns invoke.error when the requested tool is not in the manifest", async () => {
    const adapter = new AdapterModule({ baseUrl: server.baseUrl });
    const channel = new TestProcessChannel();
    const manifestService = new ManifestService();

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", {
      type: "invoke.tool",
      requestId: "req-missing-tool",
      serviceName: "test-service",
      toolName: "does-not-exist",
      parameters: {
        input: "hello",
      },
    });

    await waitForMessageCount(channel, 1);

    expect(channel.sent).toEqual([
      {
        type: "invoke.error",
        requestId: "req-missing-tool",
        message:
          "Tool 'does-not-exist' not found in manifest for service 'test-service'.",
      },
    ]);

    expect(server.calls).toEqual([]);
  });

  it("returns invoke.error when the service is disabled", async () => {
    const adapter = new AdapterModule({ baseUrl: server.baseUrl });
    const channel = new TestProcessChannel();
    const manifestService = new ManifestService();

    await db
      .update(manifests)
      .set({ enabled: false })
      .where(sql`${manifests.id} = 'test-service'`);

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", {
      type: "invoke.tool",
      requestId: "req-disabled-service",
      serviceName: "test-service",
      toolName: "echo",
      parameters: {
        input: "hello",
      },
    });

    await waitForMessageCount(channel, 1);

    expect(channel.sent).toEqual([
      {
        type: "invoke.error",
        requestId: "req-disabled-service",
        message: "Service 'test-service' is disabled and cannot be invoked.",
      },
    ]);

    expect(server.calls).toEqual([]);
  });

  it("returns invoke.error when the tool is disabled", async () => {
    const adapter = new AdapterModule({ baseUrl: server.baseUrl });
    const channel = new TestProcessChannel();
    const manifestService = new ManifestService();

    await db
      .update(tools)
      .set({ enabled: false })
      .where(
        sql`${tools.serviceName} = 'test-service' AND ${tools.name} = 'echo'`,
      );

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", {
      type: "invoke.tool",
      requestId: "req-disabled-tool",
      serviceName: "test-service",
      toolName: "echo",
      parameters: {
        input: "hello",
      },
    });

    await waitForMessageCount(channel, 1);

    expect(channel.sent).toEqual([
      {
        type: "invoke.error",
        requestId: "req-disabled-tool",
        message:
          "Tool 'echo' in service 'test-service' is disabled and cannot be invoked.",
      },
    ]);

    expect(server.calls).toEqual([]);
  });

  it("returns invoke.error when invoke parameters do not match schema", async () => {
    const adapter = new AdapterModule({ baseUrl: server.baseUrl });
    const channel = new TestProcessChannel();
    const manifestService = new ManifestService();

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", {
      type: "invoke.tool",
      requestId: "req-invalid-input",
      serviceName: "test-service",
      toolName: "echo",
      parameters: {
        input: 123,
      },
    });

    await waitForMessageCount(channel, 1);

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toMatchObject({
      type: "invoke.error",
      requestId: "req-invalid-input",
    });
    expect(server.calls).toEqual([]);
  });

  it("returns invoke.error when tool output does not match schema", async () => {
    const adapter = new AdapterModule({ baseUrl: server.baseUrl });
    const channel = new TestProcessChannel();
    const manifestService = new ManifestService();

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", {
      type: "invoke.tool",
      requestId: "req-broken-output",
      serviceName: "test-service",
      toolName: "broken-output",
      parameters: {},
    });

    await waitForMessageCount(channel, 1);

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toMatchObject({
      type: "invoke.error",
      requestId: "req-broken-output",
    });
    expect(server.calls).toEqual([
      {
        toolName: "broken-output",
        body: {},
      },
    ]);
  });
});
