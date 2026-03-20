import { createApp } from "@/app";
import { logger } from "@/logger";
import { ProcessService } from "@/services/process.service";
import { loadServerState } from "@/state";

const PORT = Number(process.env.PORT ?? 7687);
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const parsedShutdownTimeout = process.env.SHUTDOWN_TIMEOUT_MS
  ? Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10)
  : undefined;
const SHUTDOWN_TIMEOUT_MS = Number.isFinite(parsedShutdownTimeout)
  ? Math.max(0, Math.floor(parsedShutdownTimeout as number))
  : DEFAULT_SHUTDOWN_TIMEOUT_MS;

if (
  process.env.SHUTDOWN_TIMEOUT_MS !== undefined &&
  !Number.isFinite(parsedShutdownTimeout)
) {
  logger.warn(
    { value: process.env.SHUTDOWN_TIMEOUT_MS },
    "Invalid SHUTDOWN_TIMEOUT_MS; using default",
  );
}

const startServer = async () => {
  const serverState = await loadServerState();
  await serverState.pools.environment.initialize(
    serverState.modules.loaded.environment,
  );

  const processService = new ProcessService(serverState.pools.environment);
  const app = createApp();

  app.locals.serverState = serverState;
  app.locals.processService = processService;

  const server = app.listen(PORT, () => {
    logger.info(`Listening on port: ${PORT}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "Shutting down server");

    const raceWithTimeout = async <T>(label: string, task: Promise<T>) => {
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutError = new Error(
        `${label} timed out after ${SHUTDOWN_TIMEOUT_MS}ms`,
      );
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(timeoutError), SHUTDOWN_TIMEOUT_MS);
      });

      try {
        const result = await Promise.race([task, timeoutPromise]);
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        return result;
      } catch (err) {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (err === timeoutError) {
          logger.error({ err }, `${label} timed out`);
          process.exit(1);
        }
        throw err;
      }
    };

    try {
      await raceWithTimeout(
        "Server close",
        new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        }),
      );
    } catch (err) {
      logger.error({ err }, "Failed to close server");
    }

    try {
      await raceWithTimeout(
        "Environment pool shutdown",
        serverState.pools.environment.shutdown(),
      );
    } catch (err) {
      logger.error({ err }, "Failed to teardown environment pool");
    }

    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
};

startServer().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
