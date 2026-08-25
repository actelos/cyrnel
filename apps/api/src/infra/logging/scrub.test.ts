import { describe, expect, it } from "vitest";

import { scrubLogObject, scrubString } from "@/infra/logging/scrub";

describe("scrubString", () => {
  it("redacts bearer tokens", () => {
    const input =
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload";
    expect(scrubString(input)).toContain("***REDACTED***");
    expect(scrubString(input)).not.toContain(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    );
  });

  it("redacts base64-encoded 32-byte keys", () => {
    const key = ["MDEyMzQ1Njc4OWFi", "Y2RlZjAxMjM0NTY3", "ODlhYmNkZWY="].join(
      "",
    );
    expect(scrubString(key)).toBe("***REDACTED***");
  });

  it("redacts sk- prefixed API keys", () => {
    const input = "sk-abcdefghijklmnopqrstuvwxyz123456";
    expect(scrubString(input)).toBe("***REDACTED***");
  });

  it("redacts long opaque tokens", () => {
    const token = [
      "a1b2c3d4e5f6a1b2c3d4e5f6",
      "a1b2c3d4e5f6a1b2c3d4e5f6",
      "a1b2",
    ].join("");
    expect(scrubString(`value=${token}`)).not.toContain(token);
  });

  it("redacts key=value secret patterns but preserves the key name", () => {
    expect(scrubString("api_key=superSecretValue123")).toBe(
      "api_key=***REDACTED***",
    );
    const tokenValue = ["abcdef", "1234567890"].join("");
    expect(scrubString(`token: ${tokenValue}`)).toBe("token: ***REDACTED***");
    expect(scrubString("password=correcthorsebatterystaple")).toBe(
      "password=***REDACTED***",
    );
  });

  it("leaves short ordinary strings untouched", () => {
    expect(scrubString("hello world")).toBe("hello world");
    expect(scrubString("Failed to load service 'github'")).toBe(
      "Failed to load service 'github'",
    );
  });

  it("leaves long words with non-word separators untouched", () => {
    const path = "Xenova/bge-small-en-v1.5";
    expect(scrubString(path)).toBe(path);
  });
});

describe("scrubLogObject", () => {
  it("recursively scrubs nested values", () => {
    const obj = {
      message: "setup failed",
      metadata: {
        envConfig: { apiKey: "superSecretValue123" },
        headers: ["Bearer abcdef1234567890abcdef1234567890abcdef12"],
      },
    };
    const scrubbed = scrubLogObject(obj);
    expect(scrubbed.metadata.envConfig.apiKey).toBe("***REDACTED***");
    expect(scrubbed.metadata.headers[0]).toContain("***REDACTED***");
    expect(JSON.stringify(scrubbed)).not.toContain("superSecretValue123");
  });

  it("preserves non-string values", () => {
    const obj = { count: 5, ok: true, nested: { n: 3 } };
    expect(scrubLogObject(obj)).toEqual(obj);
  });
});
