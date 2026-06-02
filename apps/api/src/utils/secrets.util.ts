import crypto from "node:crypto";

import { HttpError } from "@/models/error.model";
import type { EncryptedSecretsPayload } from "@/models/secrets.model";

export type { EncryptedSecretsPayload } from "@/models/secrets.model";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getSecretsKey(): Buffer {
  const raw = process.env.MCI_SECRETS_KEY;
  if (!raw) throw new HttpError(500, "Secrets key is not configured.");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32)
    throw new HttpError(
      500,
      "Secrets key must be 32 bytes base64-encoded (MCI_SECRETS_KEY).",
    );
  return key;
}

export function encryptSecrets(
  secrets: Record<string, unknown>,
): EncryptedSecretsPayload {
  const key = getSecretsKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(secrets ?? {}), "utf8"),
    cipher.final(),
  ]);
  return {
    alg: ALGORITHM,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptSecrets(
  payload: EncryptedSecretsPayload,
): Record<string, unknown> {
  if (payload.alg !== ALGORITHM)
    throw new HttpError(500, "Unsupported secrets encryption algorithm.");

  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");

  if (iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH)
    throw new HttpError(500, "Secrets payload is malformed.");

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, getSecretsKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (err) {
    throw new HttpError(
      500,
      err instanceof Error ? err.message : "Failed to decrypt stored secrets.",
    );
  }
}
