import { createApp } from "@/app";
import { logger } from "@/logger";
import { ProcessService } from "@/services/process.service";
import { loadServerState } from "@/state";

const PORT = Number(process.env.PORT ?? 7687);

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

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    } catch (err) {
      logger.error({ err }, "Failed to close server");
    }

    try {
      await serverState.pools.environment.shutdown();
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
