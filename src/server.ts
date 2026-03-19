import { createApp } from "@/app";
import { logger } from "@/logger";
import { loadServerState } from "@/state";

const PORT = Number(process.env.PORT ?? 7687);

const startServer = async () => {
  const serverState = await loadServerState();
  const app = createApp();

  app.locals.serverState = serverState;

  app.listen(PORT, () => {
    logger.info(`Listening on port: ${PORT}`);
  });
};

startServer().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
