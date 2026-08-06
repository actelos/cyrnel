import type { Request, Response } from "express";
import rateLimit from "express-rate-limit";

import { logger } from "@/services/log.service";

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
      const retryAfter = Math.ceil(windowMs / 1000);
      logger.warn(
        { event: "rate-limit-exceeded", rateLimited: true, route: label },
        "Rate limit exceeded",
      );
      res.status(429).json({
        error: "rate_limit_exceeded",
        message: `Too many requests. Try again in ${retryAfter} seconds.`,
        retryAfter,
      });
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
