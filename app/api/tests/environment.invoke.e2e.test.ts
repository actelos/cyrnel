import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { sql } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@/app";
import { db } from "@/db/client";
import type { ServiceManifestDefinition } from "@/models/manifest.model";
import type { Process } from "@/models/process.model";
import { computeContentHash } from "@/utils/hash.util";

interface StartedToolServer {
  readonly baseUrl: string;
  readonly calls: Array<{ toolName: string; body: unknown }>;
  close: () => Promise<void>;
}

const serviceName = "liveService";

const manifestV1 = (baseUrl: string): ServiceManifestDefinition => ({
  name: serviceName,
  description: "",
  enabled: true,
  configSchema: { type: "null" },
  metadata: {
    serverUrl: baseUrl,
  },
  tools: [
    {
      name: "echo",
      description: "",
      enabled: true,
      metadata: {
        route: "echo-v1",
      },
      inputSchema: {
        type: "object",
        required: ["input"],
        properties: {
          input: {
            type: "string",
          },
        },
      },
      outputSchema: {
        type: "string",
      },
    },
  ],
  secretsSchema: { type: "null" },
});

const manifestV2 = (baseUrl: string): ServiceManifestDefinition => ({
  name: serviceName,
  description: "",
  enabled: true,
  configSchema: { type: "null" },
  metadata: {
    serverUrl: baseUrl,
  },
  tools: [
    {
      name: "echo",
      description: "",
      enabled: true,
      metadata: {
        route: "echo-v2",
      },
      inputSchema: {
        type: "object",
        required: ["input"],
        properties: {
          input: {
            type: "string",
          },
        },
      },
      outputSchema: {
        type: "string",
      },
    },
  ],
  secretsSchema: { type: "null" },
});

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

async function insertDefinition(
  definitionId: string,
  manifest: ServiceManifestDefinition,
): Promise<void> {
  const content = JSON.stringify(manifest);

  await db.insert(definitions).values({
    id: definitionId,
    type: "foo",
    description: "",
    content: Buffer.from(content, "utf8"),
    hash: computeContentHash(content),
  });
}

async function startToolServer(): Promise<StartedToolServer> {
  const calls: Array<{ toolName: string; body: unknown }> = [];

  const server = createServer((req, res) => {
    void handleToolServerRequest(req, res, calls);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve tool server address.");
  }

  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
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

async function handleToolServerRequest(
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

  if (!isObject(body) || typeof body.input !== "string") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Field 'input' must be a string." }));
    return;
  }

  if (toolName === "echo-v1") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ output: `v1:${body.input}` }));
    return;
  }

  if (toolName === "echo-v2") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ output: `v2:${body.input}` }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: `Tool '${toolName}' not found.` }));
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

async function waitForProcessIdle(
  app: ReturnType<typeof createApp>,
  pid: number,
): Promise<Process> {
  for (let i = 0; i < 300; i += 1) {
    const response = await request(app).get(`/processes/${pid}`);

    if (response.status !== 200) {
      throw new Error(
        `Unexpected status while polling process: ${response.status}`,
      );
    }

    const process = response.body as Process;

    if (process.state === "idle") {
      return process;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for process '${pid}' to become idle.`);
}

describe.skip("environment tool invocation e2e", () => {
  let toolServer: StartedToolServer;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    await resetManifestTables();
    toolServer = await startToolServer();
    app = createApp();
  });

  afterEach(async () => {
    await app.locals.processService.shutdown();
    await app.locals.environmentPoolService.shutdown();
    await toolServer.close();
  });

  it("registers, invokes, updates, invokes again, then deletes service bindings", async () => {
    const v1 = manifestV1(toolServer.baseUrl);
    const v2 = manifestV2(toolServer.baseUrl);

    await insertDefinition("def-live-v1", v1);
    await insertDefinition("def-live-v2", v2);

    await request(app)
      .post(`/services/${serviceName}`)
      .send({ definitionId: "def-live-v1" })
      .expect(201);

    const environmentModule = app.locals.environmentPoolService.allocate();
    environmentModule.setServiceManifestBindings(v1);

    const firstProcess = await request(app)
      .post("/processes")
      .send({
        code: `
          const output = await invoke.liveService.echo({ input: "hello" });
          emitOutput("toolOutput", output);
          return output;
        `,
      })
      .expect(201);

    const firstPid = firstProcess.body.pid as number;
    const firstStatus = await waitForProcessIdle(app, firstPid);
    expect(firstStatus.status).toBe("success");

    const firstOutput = await request(app)
      .get(`/processes/${firstPid}/output`)
      .expect(200);

    expect(firstOutput.body).toEqual({
      toolOutput: "v1:hello",
      result: "v1:hello",
    });

    expect(toolServer.calls).toEqual([
      {
        toolName: "echo-v1",
        body: {
          input: "hello",
        },
      },
    ]);

    await app.locals.manifestService.updateService(serviceName, "def-live-v2");
    environmentModule.updateServiceManifestBindings(v2);

    const secondProcess = await request(app)
      .post("/processes")
      .send({
        code: `
          const output = await invoke.liveService.echo({ input: "hello-again" });
          emitOutput("toolOutput", output);
          return output;
        `,
      })
      .expect(201);

    const secondPid = secondProcess.body.pid as number;
    const secondStatus = await waitForProcessIdle(app, secondPid);
    expect(secondStatus.status).toBe("success");

    const secondOutput = await request(app)
      .get(`/processes/${secondPid}/output`)
      .expect(200);

    expect(secondOutput.body).toEqual({
      toolOutput: "v2:hello-again",
      result: "v2:hello-again",
    });

    expect(toolServer.calls).toEqual([
      {
        toolName: "echo-v1",
        body: {
          input: "hello",
        },
      },
      {
        toolName: "echo-v2",
        body: {
          input: "hello-again",
        },
      },
    ]);

    await request(app).delete(`/services/${serviceName}`).expect(204);
    environmentModule.deleteServiceManifestBindings(serviceName);

    const thirdProcess = await request(app)
      .post("/processes")
      .send({
        code: `
          emitOutput("hasService", "liveService" in invoke);
          return "done";
        `,
      })
      .expect(201);

    const thirdPid = thirdProcess.body.pid as number;
    const thirdStatus = await waitForProcessIdle(app, thirdPid);
    expect(thirdStatus.status).toBe("success");

    const thirdOutput = await request(app)
      .get(`/processes/${thirdPid}/output`)
      .expect(200);

    expect(thirdOutput.body).toEqual({
      hasService: false,
      result: "done",
    });

    await request(app).get(`/services/${serviceName}`).expect(404);
  });
});
