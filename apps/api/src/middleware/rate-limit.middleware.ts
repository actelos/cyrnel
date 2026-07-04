import type { Request, Response } from "express";
import rateLimit from "express-rate-limit";

import { logger } from "@/logger";

export function createRateLimiter(
  max: number,
  windowMs: number,
  label: string,
) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req: Request, res: Response) => {
      logger.warn({ rateLimited: true, route: label }, "Rate limit exceeded");
      res
        .status(429)
        .json({ error: "Too many requests. Please try again later." });
    },
  });
}

export function globalRateLimiter() {
  const maxStr = process.env.CYRNEL_RATE_LIMIT_MAX;
  const windowMsStr = process.env.CYRNEL_RATE_LIMIT_WINDOW_MS;

  if (!maxStr || !windowMsStr) return null;

  const max = Number(maxStr);
  const windowMs = Number(windowMsStr);

  if (
    !Number.isFinite(max) ||
    !Number.isFinite(windowMs) ||
    max < 1 ||
    windowMs < 1
  )
    return null;

  return createRateLimiter(max, windowMs, "global");
}
