import pino from "pino";

const env = process.env.NODE_ENV;
const isProd = env === "production";
const isTest = env === "test";

const transport = isProd
  ? undefined
  : {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    };

export const logger = isTest
  ? pino({ level: "silent" })
  : pino(transport ? { transport } : undefined);
