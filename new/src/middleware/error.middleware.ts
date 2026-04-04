import type { ErrorRequestHandler } from "express";

import { logger } from "@/logger";

export const errorMiddleware: ErrorRequestHandler = (err, _req, res, _next) => {
  logger.error({ err }, "request failed");

  const status =
    typeof (err as { status?: unknown }).status === "number"
      ? (err as { status: number }).status
      : 500;

  if (status >= 400 && status < 500) {
    res.status(status).json({ error: err.message });
    return;
  }

  res.status(500).json({ error: "internal_server_error" });
};
