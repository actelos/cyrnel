import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { InvokeMessageResponse } from "@/models/invoke.model";
import { AdapterModule } from "@/modules/adapter.module";
import { ManifestService } from "@/services/manifest.service";
import {
  createProcessMessageSystem,
  type ProcessMessageChannel,
} from "@/services/invoke.service";

class TestProcessChannel extends EventEmitter implements ProcessMessageChannel {
  readonly sent: InvokeMessageResponse[] = [];

  send(message: InvokeMessageResponse): boolean {
    this.sent.push(message);
    return true;
  }
}

async function waitForMessageCount(
  channel: TestProcessChannel,
  count: number,
): Promise<void> {
  const timeoutMs = 1_000;
  const start = Date.now();

  while (channel.sent.length < count && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
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

describe("invoke echo integration", () => {
  let dataDir: string;
  let server: StartedTestServer;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "mci-invoke-int-"));
    server = await startTestServer();

    const manifestsDir = path.join(dataDir, "manifests");
    await mkdir(manifestsDir, { recursive: true });
    await writeFile(
      path.join(manifestsDir, "test-service.json"),
      JSON.stringify(
        {
          metadata: {
            serverUrl: server.baseUrl,
          },
          tools: [
            {
              name: "echo",
              metadata: {},
              input_schema: {
                type: "object",
                required: ["input"],
                properties: {
                  input: {
                    type: "string",
                  },
                },
                additionalProperties: false,
              },
              output_schema: {
                type: "string",
              },
            },
            {
              name: "broken-output",
              metadata: {},
              input_schema: {
                type: "object",
                additionalProperties: true,
              },
              output_schema: {
                type: "number",
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
  });

  afterEach(async () => {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("sends process.invoke to echo tool and receives echoed output", async () => {
    const adapter = new AdapterModule({ baseUrl: server.baseUrl });
    const channel = new TestProcessChannel();
    const manifestService = new ManifestService(dataDir);

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", {
      type: "process.invoke",
      requestId: "req-echo",
      serviceId: "test-service",
      toolId: "echo",
      parameters: {
        input: "hello echo",
      },
    });

    await waitForMessageCount(channel, 1);

    expect(channel.sent).toEqual([
      {
        type: "process.response",
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

  it("returns process.error when the requested tool is not in the manifest", async () => {
    const adapter = new AdapterModule({ baseUrl: server.baseUrl });
    const channel = new TestProcessChannel();
    const manifestService = new ManifestService(dataDir);

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", {
      type: "process.invoke",
      requestId: "req-missing-tool",
      serviceId: "test-service",
      toolId: "does-not-exist",
      parameters: {
        input: "hello",
      },
    });

    await waitForMessageCount(channel, 1);

    expect(channel.sent).toEqual([
      {
        type: "process.error",
        requestId: "req-missing-tool",
        error: {
          message:
            "Tool 'does-not-exist' not found in manifest for service 'test-service'.",
        },
      },
    ]);

    expect(server.calls).toEqual([]);
  });

  it("returns process.error when invoke parameters do not match schema", async () => {
    const adapter = new AdapterModule({ baseUrl: server.baseUrl });
    const channel = new TestProcessChannel();
    const manifestService = new ManifestService(dataDir);

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", {
      type: "process.invoke",
      requestId: "req-invalid-input",
      serviceId: "test-service",
      toolId: "echo",
      parameters: {
        input: 123,
      },
    });

    await waitForMessageCount(channel, 1);

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toMatchObject({
      type: "process.error",
      requestId: "req-invalid-input",
    });
    expect(server.calls).toEqual([]);
  });

  it("returns process.error when tool output does not match schema", async () => {
    const adapter = new AdapterModule({ baseUrl: server.baseUrl });
    const channel = new TestProcessChannel();
    const manifestService = new ManifestService(dataDir);

    createProcessMessageSystem(adapter, channel, { manifestService });

    channel.emit("message", {
      type: "process.invoke",
      requestId: "req-broken-output",
      serviceId: "test-service",
      toolId: "broken-output",
      parameters: {},
    });

    await waitForMessageCount(channel, 1);

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toMatchObject({
      type: "process.error",
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
