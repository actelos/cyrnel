import pino from "pino";

const env = process.env.NODE_ENV;

export const logger = pino(
  env === "test"
    ? { level: "silent" }
    : env === "production"
      ? {}
      : {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:standard",
              ignore: "pid,hostname",
            },
          },
        },
);
