#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";
import type { Transport } from "@/app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ quiet: true, path: path.resolve(__dirname, "../.env") });
dotenv.config({ quiet: true });

const { App } = await import("@/app.js");
const { logger } = await import("@/logger.js");

const { MCP_TRANSPORT, MCP_HTTP_HOST, MCP_HTTP_PORT } = z
  .object({
    MCP_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
    MCP_HTTP_HOST: z.string().min(1).default("127.0.0.1"),
    MCP_HTTP_PORT: z.coerce.number().int().positive().default(9373),
  })
  .parse(process.env);

const transport: Transport =
  MCP_TRANSPORT === "stdio"
    ? { type: "stdio" }
    : { type: "http", host: MCP_HTTP_HOST, port: MCP_HTTP_PORT };

const app = new App();
await app.start(transport);

logger.info({ transport }, "MCP server started");

let shuttingDown = false;

const shutdown = async () => {
  if (shuttingDown) return process.exit(1);
  shuttingDown = true;

  try {
    logger.info("Shutting down");
    await app.shutdown();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, "Shutdown failed");
    process.exit(1);
  }
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
