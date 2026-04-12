import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

import { HttpError } from "@/models/error.model";

function extractBearerToken(
  authorizationHeader: string | undefined,
): string | null {
  if (!authorizationHeader) {
    return null;
  }

  const [scheme, token, ...rest] = authorizationHeader.trim().split(/\s+/);

  if (rest.length > 0) {
    return null;
  }

  if (scheme?.toLowerCase() !== "bearer") {
    return null;
  }

  return token ?? null;
}

function isValidToken(providedToken: string, expectedToken: string): boolean {
  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(expectedToken);

  if (provided.byteLength !== expected.byteLength) {
    return false;
  }

  return timingSafeEqual(provided, expected);
}

export function apiKeyMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const expectedApiKey = process.env.MCI_API_KEY;

  if (!expectedApiKey) {
    next();
    return;
  }

  const providedToken = extractBearerToken(req.header("authorization"));

  if (!providedToken || !isValidToken(providedToken, expectedApiKey)) {
    next(new HttpError(401, "Unauthorized"));
    return;
  }

  next();
}
