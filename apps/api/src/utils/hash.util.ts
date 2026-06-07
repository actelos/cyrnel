import { createHash } from "node:crypto";

export const computeContentHash = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

export const computeBinaryHash = (content: Buffer): string =>
  createHash("sha256").update(content).digest("hex");
