import type { NextFunction, Request, Response } from "express";

import { logger } from "@/logger";
import { HttpError } from "@/models/error";

export function errorMiddleware(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  logger.error({ err: error }, "Request failed");
  if (error instanceof HttpError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }

  res.status(500).json({ error: "Internal server error." });
}
