import crypto from "node:crypto";

import { HttpError } from "@/models/error.model";
import type { EncryptedSecretsPayload } from "@/models/secrets.model";

export type { EncryptedSecretsPayload } from "@/models/secrets.model";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getSecretsKey(): Buffer {
  const raw = process.env.MCI_SECRETS_KEY;

  if (!raw) {
    throw new HttpError(500, "Secrets key is not configured.");
  }

  const key = Buffer.from(raw, "base64");

  if (key.length !== 32) {
    throw new HttpError(
      500,
      "Secrets key must be 32 bytes base64-encoded (MCI_SECRETS_KEY).",
    );
  }

  return key;
}

function ensureObject(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }

  return {};
}

export function encryptSecrets(
  secrets: Record<string, unknown>,
): EncryptedSecretsPayload {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getSecretsKey(), iv);
  const plaintext = JSON.stringify(secrets ?? {});
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    alg: ALGORITHM,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptSecrets(
  payload: EncryptedSecretsPayload,
): Record<string, unknown> {
  if (!payload || payload.alg !== ALGORITHM) {
    throw new HttpError(500, "Unsupported secrets encryption algorithm.");
  }

  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");

  if (iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH) {
    throw new HttpError(500, "Secrets payload is malformed.");
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, getSecretsKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");

    return ensureObject(JSON.parse(plaintext));
  } catch (error) {
    throw new HttpError(
      500,
      error instanceof Error
        ? error.message
        : "Failed to decrypt stored secrets.",
    );
  }
}

export function normalizeSecrets(
  payload: unknown,
  errorMessage = "Secrets payload must be a JSON object.",
): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }

  throw new HttpError(400, errorMessage);
}
