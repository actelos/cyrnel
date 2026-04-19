import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

function isValidCredential(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);

  if (providedBuf.byteLength !== expectedBuf.byteLength) {
    return false;
  }

  return timingSafeEqual(providedBuf, expectedBuf);
}

export function login(req: Request, res: Response): void {
  const expectedUsername = process.env.MCI_AUTH_USERNAME;
  const expectedPassword = process.env.MCI_AUTH_PASSWORD;

  if (!expectedUsername || !expectedPassword) {
    res.status(503).json({ error: "Authentication not configured." });
    return;
  }

  const { username, password } = req.body as {
    username?: unknown;
    password?: unknown;
  };

  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "Invalid request body." });
    return;
  }

  if (
    isValidCredential(username, expectedUsername) &&
    isValidCredential(password, expectedPassword)
  ) {
    res.status(200).json({ success: true });
    return;
  }

  res.status(401).json({ error: "Invalid credentials." });
}
