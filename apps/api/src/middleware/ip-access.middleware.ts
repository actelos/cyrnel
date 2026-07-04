import type { NextFunction, Request, Response } from "express";
import ipaddr from "ipaddr.js";

import { HttpError } from "@/models/error.model";

type ParsedCIDR = [ipaddr.IPv4 | ipaddr.IPv6, number];

let cachedAllowedEnv: string | undefined;
let cachedAllowedCIDRs: ParsedCIDR[] = [];

let cachedBlockedEnv: string | undefined;
let cachedBlockedCIDRs: ParsedCIDR[] = [];

function parseCIDRList(value?: string): ParsedCIDR[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => ipaddr.parseCIDR(entry) as ParsedCIDR);
}

function getAllowedCIDRs(): ParsedCIDR[] {
  const value = process.env.CYRNEL_ALLOWED_IPS;
  if (value !== cachedAllowedEnv) {
    cachedAllowedEnv = value;
    cachedAllowedCIDRs = parseCIDRList(value);
  }
  return cachedAllowedCIDRs;
}

function getBlockedCIDRs(): ParsedCIDR[] {
  const value = process.env.CYRNEL_BLOCKED_IPS;
  if (value !== cachedBlockedEnv) {
    cachedBlockedEnv = value;
    cachedBlockedCIDRs = parseCIDRList(value);
  }
  return cachedBlockedCIDRs;
}

function matchesCIDRs(address: string, cidrs: ParsedCIDR[]): boolean {
  const parsed = ipaddr.process(address);
  return cidrs.some(
    ([range, prefix]) =>
      parsed.kind() === range.kind() && parsed.match(range, prefix),
  );
}

export function ipAccessMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const blockedCIDRs = getBlockedCIDRs();
  const allowedCIDRs = getAllowedCIDRs();

  const clientIp = req.ip ?? req.socket.remoteAddress ?? "";

  if (blockedCIDRs.length > 0 && matchesCIDRs(clientIp, blockedCIDRs)) {
    next(new HttpError(403, "Access denied."));
    return;
  }

  if (allowedCIDRs.length > 0 && !matchesCIDRs(clientIp, allowedCIDRs)) {
    next(new HttpError(403, "Access denied."));
    return;
  }

  next();
}
