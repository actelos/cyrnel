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

const redactConfig = {
  paths: [
    "req.headers.authorization",
    "req.headers.cookie",
    'req.headers["set-cookie"]',
  ],
  censor: "***REDACTED***",
};

export const logger = pino(
  NODE_ENV === "test"
    ? { level: "silent" }
    : NODE_ENV === "production"
      ? { level: LOG_LEVEL ?? "info", redact: redactConfig }
      : { ...devTransport, level: LOG_LEVEL ?? "debug", redact: redactConfig },
);
