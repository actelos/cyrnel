import pino from "pino";

const { NODE_ENV, LOG_LEVEL } = process.env;

const devTransport = {
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    },
  },
};

export const logger = pino(
  NODE_ENV === "test"
    ? { level: "silent" }
    : NODE_ENV === "production"
      ? { level: LOG_LEVEL ?? "info" }
      : { ...devTransport, level: LOG_LEVEL ?? "debug" },
);
