import crypto from "node:crypto";
import { logger } from "@/infra/logging";
import { HttpError } from "@/models/error.model";
import type { EncryptedSecretsPayload } from "@/models/secrets.model";

export type { EncryptedSecretsPayload } from "@/models/secrets.model";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function deriveKeyId(key: Buffer): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function getPrimaryKey(): { id: string; key: Buffer } {
  const raw = process.env.CYRNEL_SECRETS_KEY;
  if (!raw) throw new HttpError(500, "Secrets key is not configured.");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32)
    throw new HttpError(
      500,
      "Secrets key must be 32 bytes base64-encoded (CYRNEL_SECRETS_KEY).",
    );
  return { id: deriveKeyId(key), key };
}

function getPreviousKeys(): Array<{ id: string; key: Buffer }> {
  const raw = process.env.CYRNEL_SECRETS_PREVIOUS_KEYS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const key = Buffer.from(entry, "base64");
      if (key.length !== 32)
        throw new HttpError(
          500,
          "Previous secrets key must be 32 bytes base64-encoded (CYRNEL_SECRETS_PREVIOUS_KEYS).",
        );
      return { id: deriveKeyId(key), key };
    });
}

function getAllKeys(): Array<{ id: string; key: Buffer }> {
  const primary = getPrimaryKey();
  const previous = getPreviousKeys();

  if (previous.some((k) => k.id === primary.id))
    throw new HttpError(
      500,
      "Primary secrets key collides with a previous key - check CYRNEL_SECRETS_KEY and CYRNEL_SECRETS_PREVIOUS_KEYS.",
    );

  return [primary, ...previous];
}

let cachedPrimaryKeyId: string | null = null;

export function getPrimaryKeyId(): string {
  if (!cachedPrimaryKeyId) {
    cachedPrimaryKeyId = getPrimaryKey().id;
  }
  return cachedPrimaryKeyId;
}

export function encryptSecrets(
  secrets: Record<string, unknown>,
): EncryptedSecretsPayload {
  const { id, key } = getPrimaryKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(secrets ?? {}), "utf8"),
    cipher.final(),
  ]);
  return {
    kid: id,
    alg: ALGORITHM,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function shouldReEncrypt(payload: { kid?: string }): boolean {
  return payload.kid !== getPrimaryKeyId();
}

export type ReEncryptPersistFn = (
  payload: EncryptedSecretsPayload,
) => Promise<void>;

export async function decryptAndMaybeReEncrypt(
  payload: EncryptedSecretsPayload,
  persist: ReEncryptPersistFn,
  logMeta: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const secrets = decryptSecrets(payload);

  if (shouldReEncrypt(payload)) {
    try {
      const reEncrypted = encryptSecrets(secrets);
      await persist(reEncrypted);
      logger.debug(
        { event: "secrets-reencrypted", ...logMeta },
        "Re-encrypted secrets with primary key",
      );
    } catch (err) {
      logger.warn(
        { event: "secrets-reencrypt-persist-failed", err, ...logMeta },
        "Failed to persist re-encrypted secrets",
      );
    }
  }

  return secrets;
}

export function collectPresentPaths(
  obj: Record<string, unknown>,
  basePath = "",
): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = basePath ? `${basePath}/${key}` : `/${key}`;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      paths.push(
        ...collectPresentPaths(value as Record<string, unknown>, path),
      );
    } else {
      paths.push(path);
    }
  }
  return paths;
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

  const keys = getAllKeys();

  if (payload.kid) {
    const match = keys.find((k) => k.id === payload.kid);
    if (match) {
      return decryptWithKey(match.key, iv, tag, ciphertext);
    }
  }

  for (const { key } of keys) {
    try {
      return decryptWithKey(key, iv, tag, ciphertext);
    } catch {}
  }

  throw new HttpError(
    500,
    "Secrets payload was encrypted with a key that is no longer available.",
  );
}

function decryptWithKey(
  key: Buffer,
  iv: Buffer,
  tag: Buffer,
  ciphertext: Buffer,
): Record<string, unknown> {
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
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
