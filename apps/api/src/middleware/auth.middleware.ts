import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

import { HttpError } from "@/models/error.model";

export function apiKeyMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const expectedApiKey = process.env.CYRNEL_API_KEY;
  if (!expectedApiKey) {
    next();
    return;
  }

  const parts = req.header("authorization")?.trim().split(/\s+/);
  const token =
    parts?.length === 2 && parts[0].toLowerCase() === "bearer"
      ? parts[1]
      : null;

  if (!token) {
    next(new HttpError(401, "Unauthorized"));
    return;
  }

  const a = Buffer.from(token);
  const b = Buffer.from(expectedApiKey);
  if (a.byteLength !== b.byteLength || !timingSafeEqual(a, b)) {
    next(new HttpError(401, "Unauthorized"));
    return;
  }

  next();
}
