import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HttpError } from "@/models/error.model";
import {
  decryptSecrets,
  type EncryptedSecretsPayload,
  encryptSecrets,
  getPrimaryKeyId,
} from "@/utils/secrets.util";

const VALID_KEY = crypto.randomBytes(32).toString("base64");

describe("secrets.util", () => {
  const originalKey = process.env.CYRNEL_SECRETS_KEY;

  beforeEach(() => {
    process.env.CYRNEL_SECRETS_KEY = VALID_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.CYRNEL_SECRETS_KEY;
    } else {
      process.env.CYRNEL_SECRETS_KEY = originalKey;
    }
  });

  describe("encryptSecrets", () => {
    it("produces a payload with the expected shape", () => {
      const payload = encryptSecrets({ token: "abc" });

      expect(typeof payload.kid).toBe("string");
      expect(payload.alg).toBe("aes-256-gcm");
      expect(typeof payload.iv).toBe("string");
      expect(typeof payload.tag).toBe("string");
      expect(typeof payload.ciphertext).toBe("string");
      expect(Buffer.from(payload.iv, "base64").length).toBe(12);
      expect(Buffer.from(payload.tag, "base64").length).toBe(16);
    });

    it("includes kid matching the primary key id", () => {
      const payload = encryptSecrets({ token: "abc" });
      expect(payload.kid).toBe(getPrimaryKeyId());
    });

    it("uses a fresh IV on each call (different ciphertext for same input)", () => {
      const a = encryptSecrets({ token: "abc" });
      const b = encryptSecrets({ token: "abc" });

      expect(a.iv).not.toBe(b.iv);
      expect(a.ciphertext).not.toBe(b.ciphertext);
    });

    it("throws HttpError(500) when the secrets key is missing", () => {
      delete process.env.CYRNEL_SECRETS_KEY;

      try {
        encryptSecrets({ token: "abc" });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(500);
        expect((err as HttpError).message).toMatch(/not configured/);
      }
    });

    it("throws HttpError(500) when the key is not 32 bytes", () => {
      process.env.CYRNEL_SECRETS_KEY = Buffer.alloc(16).toString("base64");

      try {
        encryptSecrets({ token: "abc" });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(500);
        expect((err as HttpError).message).toMatch(/32 bytes/);
      }
    });
  });

  describe("decryptSecrets", () => {
    it("round-trips an arbitrary secrets object", () => {
      const secrets = { token: "abc", nested: { count: 7 }, bool: true };
      const payload = encryptSecrets(secrets);

      expect(decryptSecrets(payload)).toEqual(secrets);
    });

    it("returns an empty object when encrypting null/undefined", () => {
      const payload = encryptSecrets(
        undefined as unknown as Record<string, unknown>,
      );

      expect(decryptSecrets(payload)).toEqual({});
    });

    it("normalizes non-object plaintext to an empty object", () => {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(
        "aes-256-gcm",
        Buffer.from(VALID_KEY, "base64"),
        iv,
      );
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify([1, 2, 3]), "utf8"),
        cipher.final(),
      ]);

      const payload: EncryptedSecretsPayload = {
        alg: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };

      expect(decryptSecrets(payload)).toEqual({});
    });

    it("rejects payloads with an unsupported algorithm", () => {
      const payload = encryptSecrets({ token: "abc" });
      const bad = {
        ...payload,
        alg: "aes-128-gcm" as unknown as "aes-256-gcm",
      };

      try {
        decryptSecrets(bad);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(500);
        expect((err as HttpError).message).toMatch(/Unsupported/);
      }
    });

    it("rejects payloads with a malformed IV length", () => {
      const payload = encryptSecrets({ token: "abc" });
      const bad: EncryptedSecretsPayload = {
        ...payload,
        iv: Buffer.alloc(8).toString("base64"),
      };

      try {
        decryptSecrets(bad);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).message).toMatch(/malformed/);
      }
    });

    it("rejects payloads with a malformed auth tag length", () => {
      const payload = encryptSecrets({ token: "abc" });
      const bad: EncryptedSecretsPayload = {
        ...payload,
        tag: Buffer.alloc(8).toString("base64"),
      };

      try {
        decryptSecrets(bad);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).message).toMatch(/malformed/);
      }
    });

    it("throws HttpError(500) when the auth tag fails verification", () => {
      const payload = encryptSecrets({ token: "abc" });
      const tampered = Buffer.from(payload.ciphertext, "base64");
      tampered[0] = tampered[0] ^ 0xff;

      const bad: EncryptedSecretsPayload = {
        ...payload,
        ciphertext: tampered.toString("base64"),
      };

      try {
        decryptSecrets(bad);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(500);
      }
    });

    it("throws HttpError(500) when no known key can decrypt the payload", () => {
      const payload = encryptSecrets({ token: "abc" });
      process.env.CYRNEL_SECRETS_KEY = crypto
        .randomBytes(32)
        .toString("base64");

      expect(() => decryptSecrets(payload)).toThrow(HttpError);
    });

    it("decrypts a legacy payload without kid using the primary key", () => {
      const iv = crypto.randomBytes(12);
      const key = Buffer.from(VALID_KEY, "base64");
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify({ token: "abc" }), "utf8"),
        cipher.final(),
      ]);

      const payload: EncryptedSecretsPayload = {
        alg: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };

      expect(decryptSecrets(payload)).toEqual({ token: "abc" });
    });

    it("decrypts a payload encrypted with a previous key", () => {
      const oldKey = crypto.randomBytes(32);
      const primaryKey = crypto.randomBytes(32);

      process.env.CYRNEL_SECRETS_KEY = primaryKey.toString("base64");
      process.env.CYRNEL_SECRETS_PREVIOUS_KEYS = oldKey.toString("base64");

      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", oldKey, iv);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify({ token: "abc" }), "utf8"),
        cipher.final(),
      ]);

      const payload: EncryptedSecretsPayload = {
        alg: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };

      expect(decryptSecrets(payload)).toEqual({ token: "abc" });
    });

    it("tries previous keys in order when primary key does not match", () => {
      const oldKeyA = crypto.randomBytes(32);
      const oldKeyB = crypto.randomBytes(32);
      const primaryKey = crypto.randomBytes(32);

      process.env.CYRNEL_SECRETS_KEY = primaryKey.toString("base64");
      process.env.CYRNEL_SECRETS_PREVIOUS_KEYS = `${oldKeyA.toString("base64")},${oldKeyB.toString("base64")}`;

      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", oldKeyB, iv);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify({ token: "abc" }), "utf8"),
        cipher.final(),
      ]);

      const payload: EncryptedSecretsPayload = {
        alg: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };

      expect(decryptSecrets(payload)).toEqual({ token: "abc" });
    });

    it("falls back to previous keys for a legacy payload without kid", () => {
      const oldKey = crypto.randomBytes(32);
      const primaryKey = crypto.randomBytes(32);

      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", oldKey, iv);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify({ token: "abc" }), "utf8"),
        cipher.final(),
      ]);

      const payload: EncryptedSecretsPayload = {
        alg: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };

      process.env.CYRNEL_SECRETS_KEY = primaryKey.toString("base64");
      process.env.CYRNEL_SECRETS_PREVIOUS_KEYS = oldKey.toString("base64");

      expect(decryptSecrets(payload)).toEqual({ token: "abc" });
    });
  });
});
