import pino from "pino";

const { NODE_ENV, LOG_LEVEL } = process.env;

const devTransport = {
  transport: {
    target: "pino-pretty",
    options: {
      destination: 2,
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

export const logger =
  NODE_ENV === "test"
    ? pino({ level: "silent" })
    : NODE_ENV === "development" || NODE_ENV === "dev"
      ? pino({
          ...devTransport,
          level: LOG_LEVEL ?? "debug",
          redact: redactConfig,
        })
      : pino(
          { level: LOG_LEVEL ?? "info", redact: redactConfig },
          pino.destination({ dest: 2, sync: false }),
        );
