import type { NextFunction, Request, Response } from "express";

import { logger } from "@/logger";
import { HttpError } from "@/models/error.model";

export function errorMiddleware(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  (req as Request & { err?: unknown }).err = error;

  const isHttpError = error instanceof HttpError;
  const { statusCode, message } = isHttpError
    ? error
    : { statusCode: 500, message: "Internal server error." };

  if (isHttpError) {
    logger.debug(
      { err: error, method: req.method, url: req.originalUrl, statusCode },
      "Request rejected with HttpError",
    );
  } else {
    logger.error(
      { err: error, method: req.method, url: req.originalUrl },
      "Unhandled error in request pipeline",
    );
  }

  res.status(statusCode).json({ error: message });
}
