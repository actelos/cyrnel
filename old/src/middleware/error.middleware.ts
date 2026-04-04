import type { NextFunction, Request, Response } from "express";

import { HttpError } from "@/models/error";

export function errorMiddleware(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (req) (req as any).err = error;
  if (error instanceof HttpError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }

  res.status(500).json({ error: "Internal server error." });
}
