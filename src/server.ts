import { createApp } from "@/app";
import { logger } from "@/logger";

const app = createApp();
const PORT = Number(process.env.PORT ?? 7687);

app.listen(PORT, () => {
  logger.info(`Listening on port: ${PORT}`);
});
