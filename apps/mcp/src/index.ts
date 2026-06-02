import "dotenv/config";

import { z } from "zod";

import { App, type Transport } from "@/app.js";

const { MCP_TRANSPORT, MCP_HTTP_HOST, MCP_HTTP_PORT } = z
  .object({
    MCP_TRANSPORT: z.enum(["stdio", "http"]).default("http"),
    MCP_HTTP_HOST: z.string().min(1).default("127.0.0.1"),
    MCP_HTTP_PORT: z.coerce.number().int().positive().default(3333),
  })
  .parse(process.env);

const transport: Transport =
  MCP_TRANSPORT === "stdio"
    ? { type: "stdio" }
    : { type: "http", host: MCP_HTTP_HOST, port: MCP_HTTP_PORT };

const app = new App();
await app.start(transport);

let shuttingDown = false;

const shutdown = async () => {
  if (shuttingDown) return process.exit(1);
  shuttingDown = true;

  try {
    console.error(`Shutting down`);
    await app.shutdown();
    process.exit(0);
  } catch (err) {
    console.error(`Shutdown failed: ${String(err)}`);
    process.exit(1);
  }
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
