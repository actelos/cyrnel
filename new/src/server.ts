import { createApp } from "@/app";
import { logger } from "@/logger";

const app = createApp();
const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 7687;

app.listen(port, () => {
  logger.info({ port }, "Server listening");
});
