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

  app.listen(PORT, () => {
    logger.info(`Listening on port: ${PORT}`);
  });
};

startServer().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
