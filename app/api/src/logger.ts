import pino from "pino";

import { persistLogLine } from "@/services/log.service";

const env = process.env.NODE_ENV;

const prettyOptions = {
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    },
  },
};

const productionDbStream = {
  write(chunk: string | Uint8Array) {
    const line =
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");

    void persistLogLine(line);
  },
};

export const logger =
  env === "test"
    ? pino({ level: "silent" })
    : env === "production"
      ? pino(
          {},
          pino.multistream([
            { stream: process.stdout },
            { stream: productionDbStream },
          ]),
        )
      : pino(prettyOptions);
