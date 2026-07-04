import "dotenv/config";

import { z } from "zod";

import { App } from "@/app";
import { logger } from "@/logger";

const { PORT, SHUTDOWN_TIMEOUT_MS } = z
  .object({
    PORT: z.coerce.number().default(9371),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(10_000),
  })
  .parse(process.env);

const app = new App();
await app.setup();

const server = app.express.listen(PORT, () =>
  logger.info({ PORT }, "Server listening"),
);

server.maxConnections = Number(process.env.CYRNEL_MAX_CONNECTIONS) || 0;
server.keepAliveTimeout =
  process.env.CYRNEL_KEEPALIVE_TIMEOUT_MS !== undefined
    ? Number(process.env.CYRNEL_KEEPALIVE_TIMEOUT_MS)
    : 5_000;
server.headersTimeout =
  process.env.CYRNEL_HEADERS_TIMEOUT_MS !== undefined
    ? Number(process.env.CYRNEL_HEADERS_TIMEOUT_MS)
    : 6_000;
server.timeout = Number(process.env.CYRNEL_REQUEST_TIMEOUT_MS) || 0;

server.on("error", (err) => {
  logger.error({ err, PORT }, "Server failed to start");
  process.exit(1);
});

const closeServer = () =>
  new Promise<void>((res, rej) =>
    server.close((err) => (err ? rej(err) : res())),
  );

let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) return process.exit(1);
  shuttingDown = true;

  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
  logger.info({ signal }, "Shutting down");

  try {
    await closeServer();
    await app.shutdown();
    logger.info("Shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error({ err }, "Shutdown failed");
    process.exit(1);
  }
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
