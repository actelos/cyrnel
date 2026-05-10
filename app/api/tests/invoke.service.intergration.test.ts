import { EventEmitter } from "node:events";

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

function isObject(
  value: unknown,
): value is Record<string, string | number | boolean | null> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function resetManifestsTable(): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  await db.run(sql`DROP TABLE IF EXISTS tools`);
  await db.run(sql`DROP TABLE IF EXISTS configurations`);
  await db.run(sql`DROP TABLE IF EXISTS services`);
  await db.run(sql`
    CREATE TABLE services (
      id text PRIMARY KEY NOT NULL,
      type text NOT NULL,
      source text NOT NULL DEFAULT '',
      description text NOT NULL DEFAULT '',
      hash text NOT NULL,
      enabled integer NOT NULL DEFAULT 1,
      metadata text NOT NULL,
      config_schema text NOT NULL
    )
  `);
  await db.run(sql`CREATE INDEX services_type_idx ON services (type)`);
  await db.run(sql`
    CREATE TABLE configurations (
      service_name text PRIMARY KEY NOT NULL,
      config text NOT NULL DEFAULT '{}',
      updated_at integer NOT NULL,
      FOREIGN KEY (service_name) REFERENCES services(id) ON UPDATE no action ON DELETE cascade
    )
  `);
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

describe("invoke echo integration", () => {
  const baseUrl = "http://adapter.local";
  const calls: Array<{ toolName: string; body: unknown }> = [];
  let adapter: AdapterModule;

  beforeEach(async () => {
    calls.length = 0;
    await resetManifestsTable();

    adapter = new AdapterModule({
      fetchImpl: async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const toolName = decodeURIComponent(
          new URL(url).pathname.replace(/^\//, ""),
        );

        const bodyRaw = typeof init?.body === "string" ? init.body : "";
        const body = bodyRaw.trim() ? JSON.parse(bodyRaw) : {};
        calls.push({ toolName, body });

        if (toolName === "echo") {
          if (!isObject(body) || typeof body.input !== "string") {
            return new Response(
              JSON.stringify({ message: "input must be a string" }),
              {
                status: 400,
                headers: { "content-type": "application/json" },
              },
            );
          }

          return new Response(JSON.stringify({ output: body.input }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (toolName === "broken-output") {
          return new Response(JSON.stringify({ output: "not-a-number" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response(
          JSON.stringify({ message: `Tool '${toolName}' does not exist` }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });
    adapter.setServiceConfigs({});

    await db.insert(manifests).values({
      id: "test-service",
      type: "foo",
      source: `${baseUrl}/definition`,
      description: "",
      hash: "test-manifest-hash",
      metadata: {
        serverUrl: baseUrl,
      },
      configSchema: { type: "null" },
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
  });

  it("sends invoke.tool to echo tool and receives echoed output", async () => {
    const channel = new TestProcessChannel();
    const manifestService = new ManifestService();

    createProcessMessageSystem(
      { allocate: () => adapter, release: () => {} },
      channel,
      { manifestService },
    );

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

    expect(calls).toEqual([
      {
        toolName: "echo",
        body: {
          input: "hello echo",
        },
      },
    ]);
  });

  it("returns invoke.error when the requested tool is not in the manifest", async () => {
    const channel = new TestProcessChannel();
    const manifestService = new ManifestService();

    createProcessMessageSystem(
      { allocate: () => adapter, release: () => {} },
      channel,
      { manifestService },
    );

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

    expect(calls).toEqual([]);
  });

  it("returns invoke.error when the service is disabled", async () => {
    const channel = new TestProcessChannel();
    const manifestService = new ManifestService();

    await db
      .update(manifests)
      .set({ enabled: false })
      .where(sql`${manifests.id} = 'test-service'`);

    createProcessMessageSystem(
      { allocate: () => adapter, release: () => {} },
      channel,
      { manifestService },
    );

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

    expect(calls).toEqual([]);
  });

  it("returns invoke.error when the tool is disabled", async () => {
    const channel = new TestProcessChannel();
    const manifestService = new ManifestService();

    await db
      .update(tools)
      .set({ enabled: false })
      .where(
        sql`${tools.serviceName} = 'test-service' AND ${tools.name} = 'echo'`,
      );

    createProcessMessageSystem(
      { allocate: () => adapter, release: () => {} },
      channel,
      { manifestService },
    );

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

    expect(calls).toEqual([]);
  });

  it("returns invoke.error when invoke parameters do not match schema", async () => {
    const channel = new TestProcessChannel();
    const manifestService = new ManifestService();

    createProcessMessageSystem(
      { allocate: () => adapter, release: () => {} },
      channel,
      { manifestService },
    );

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
    expect(calls).toEqual([]);
  });

  it("returns invoke.error when tool output does not match schema", async () => {
    const channel = new TestProcessChannel();
    const manifestService = new ManifestService();

    createProcessMessageSystem(
      { allocate: () => adapter, release: () => {} },
      channel,
      { manifestService },
    );

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
    expect(calls).toEqual([
      {
        toolName: "broken-output",
        body: {},
      },
    ]);
  });
});
