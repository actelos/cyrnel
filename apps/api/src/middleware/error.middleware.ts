import type { NextFunction, Request, Response } from "express";
import { logger } from "@/infra/logging";
import { HttpError } from "@/models/error.model";

export function errorMiddleware(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  (req as Request & { err?: unknown }).err = error;

  const isHttpError = error instanceof HttpError;
  const { statusCode, message, code } = isHttpError
    ? error
    : { statusCode: 500, message: "Internal server error.", code: undefined };

  if (isHttpError) {
    logger.debug(
      {
        event: "http-error-rejected",
        err: error,
        method: req.method,
        url: req.originalUrl,
        statusCode,
      },
      "Request rejected with HttpError",
    );
  } else {
    logger.error(
      {
        event: "unhandled-error",
        err: error,
        method: req.method,
        url: req.originalUrl,
      },
      "Unhandled error in request pipeline",
    );
  }

  res
    .status(statusCode)
    .json(code !== undefined ? { error: message, code } : { error: message });
}
