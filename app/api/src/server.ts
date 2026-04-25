import { z } from "zod";
import { createApp } from "@/app";
import { logger } from "@/logger";

const app = createApp();
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const envSchema = z.object({
  PORT: z
    .string()
    .regex(/^\d+$/)
    .transform((value) => Number.parseInt(value, 10))
    .optional(),
  SHUTDOWN_TIMEOUT_MS: z
    .string()
    .regex(/^\d+$/)
    .transform((value) => Math.max(0, Math.floor(Number.parseInt(value, 10))))
    .optional(),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success && process.env.SHUTDOWN_TIMEOUT_MS !== undefined) {
  logger.warn(
    { value: process.env.SHUTDOWN_TIMEOUT_MS },
    "Invalid SHUTDOWN_TIMEOUT_MS; using default",
  );
}

const port = parsedEnv.success ? (parsedEnv.data.PORT ?? 7687) : 7687;
const shutdownTimeoutMs = parsedEnv.success
  ? (parsedEnv.data.SHUTDOWN_TIMEOUT_MS ?? DEFAULT_SHUTDOWN_TIMEOUT_MS)
  : DEFAULT_SHUTDOWN_TIMEOUT_MS;

const server = app.listen(port, () => {
  logger.info({ port }, "Server listening");
});

let shuttingDown = false;
let forceExit = false;
let forceTimer: ReturnType<typeof setTimeout> | null = null;

const forceShutdown = (reason: string) => {
  if (forceExit) {
    return;
  }

  forceExit = true;
  logger.error({ reason }, "Forcing shutdown");

  if (forceTimer !== null) {
    clearTimeout(forceTimer);
    forceTimer = null;
  }

  server.closeAllConnections?.();
  server.closeIdleConnections?.();

  process.exit(1);
};

const closeServer = () =>
  new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }

      resolve();
    });
  });

const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
  if (shuttingDown) {
    forceShutdown(`Received ${signal} while already shutting down`);
    return;
  }

  shuttingDown = true;
  logger.info({ signal, shutdownTimeoutMs }, "Starting graceful shutdown");

  forceTimer = setTimeout(() => {
    forceShutdown(
      `Graceful shutdown timed out after ${shutdownTimeoutMs}ms (${signal})`,
    );
  }, shutdownTimeoutMs);

  try {
    await closeServer();
    await app.locals.processService.shutdown();
    await app.locals.environmentPoolService.shutdown();

    if (forceTimer !== null) {
      clearTimeout(forceTimer);
      forceTimer = null;
    }

    logger.info("Graceful shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error({ err, signal }, "Graceful shutdown failed");
    forceShutdown("Graceful shutdown failed");
  }
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
