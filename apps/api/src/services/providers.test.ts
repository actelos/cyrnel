import { describe, expect, it } from "vitest";

import {
  CredentialUnavailable,
  declaredSchemaKeys,
  HostConfigProvider,
  HostSecretsProvider,
  ProviderError,
  ProviderKeyNotConfigured,
  ProviderKeyNotDeclared,
  ProviderReadFailed,
  ProviderScopeInvalid,
  SecretDecryptionFailed,
} from "@/services/providers";

describe("ProviderError", () => {
  it("is a base error class", () => {
    const err = new ProviderError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("test");
  });
});

describe("ProviderKeyNotDeclared", () => {
  it("includes scope and key in message", () => {
    const err = new ProviderKeyNotDeclared("config", "foo");
    expect(err.message).toBe("Key 'foo' is not declared in scope 'config'.");
    expect(err.name).toBe("ProviderKeyNotDeclared");
  });
});

describe("ProviderKeyNotConfigured", () => {
  it("includes scope and key in message", () => {
    const err = new ProviderKeyNotConfigured("secrets", "bar");
    expect(err.message).toBe("Key 'bar' is not configured in scope 'secrets'.");
    expect(err.name).toBe("ProviderKeyNotConfigured");
  });
});

describe("ProviderScopeInvalid", () => {
  it("includes scope in message", () => {
    const err = new ProviderScopeInvalid("config");
    expect(err.message).toBe("Provider scope 'config' is invalid (destroyed).");
    expect(err.name).toBe("ProviderScopeInvalid");
  });
});

describe("ProviderReadFailed", () => {
  it("includes scope, key, and cause", () => {
    const cause = new Error("oops");
    const err = new ProviderReadFailed("config", "foo", cause);
    expect(err.message).toBe("Failed to read 'foo' from scope 'config'.");
    expect(err.name).toBe("ProviderReadFailed");
    expect(err.cause).toBe(cause);
  });
});

describe("SecretDecryptionFailed", () => {
  it("includes scope, key, and cause", () => {
    const cause = new Error("decrypt failed");
    const err = new SecretDecryptionFailed("secrets", "foo", cause);
    expect(err.message).toBe(
      "Failed to decrypt secret 'foo' in scope 'secrets'.",
    );
    expect(err.name).toBe("SecretDecryptionFailed");
    expect(err.cause).toBe(cause);
  });
});

describe("CredentialUnavailable", () => {
  it("includes scheme name and scope in message", () => {
    const err = new CredentialUnavailable("apiKey", "service-1");
    expect(err.message).toBe(
      "No credential is available for scheme 'apiKey' in scope 'service-1'.",
    );
    expect(err.name).toBe("CredentialUnavailable");
  });
});

describe("declaredSchemaKeys", () => {
  it("returns empty set for null", () => {
    expect(declaredSchemaKeys(null)).toEqual(new Set());
  });

  it("returns empty set for undefined", () => {
    expect(declaredSchemaKeys(undefined)).toEqual(new Set());
  });

  it("returns empty set for non-object", () => {
    expect(declaredSchemaKeys("string")).toEqual(new Set());
    expect(declaredSchemaKeys(123)).toEqual(new Set());
  });

  it("returns empty set for object without properties", () => {
    expect(declaredSchemaKeys({ type: "object" })).toEqual(new Set());
  });

  it("returns empty set for object with null properties", () => {
    expect(declaredSchemaKeys({ properties: null })).toEqual(new Set());
  });

  it("returns keys from properties object", () => {
    const schema = {
      type: "object",
      properties: {
        foo: { type: "string" },
        bar: { type: "number" },
      },
    };
    expect(declaredSchemaKeys(schema)).toEqual(new Set(["foo", "bar"]));
  });

  it("returns a Set", () => {
    const keys = declaredSchemaKeys({
      properties: { a: {} },
    });
    expect(keys).toBeInstanceOf(Set);
  });
});

describe("HostConfigProvider", () => {
  const schema = {
    type: "object",
    properties: {
      declaredKey: { type: "string" },
      optionalKey: { type: "number" },
    },
  };
  const declaredKeys = declaredSchemaKeys(schema);

  it("returns value for declared and configured key", async () => {
    const provider = new HostConfigProvider(
      { declaredKey: "value", optionalKey: 42 },
      declaredKeys,
    );
    await expect(provider.get("declaredKey")).resolves.toBe("value");
    await expect(provider.get("optionalKey")).resolves.toBe(42);
  });

  it("throws ProviderKeyNotDeclared for undeclared key", async () => {
    const provider = new HostConfigProvider({}, declaredKeys);
    await expect(provider.get("undeclared" as never)).rejects.toBeInstanceOf(
      ProviderKeyNotDeclared,
    );
  });

  it("throws ProviderKeyNotConfigured for declared but unconfigured key", async () => {
    const provider = new HostConfigProvider({}, declaredKeys);
    await expect(provider.get("declaredKey")).rejects.toBeInstanceOf(
      ProviderKeyNotConfigured,
    );
  });

  it("throws ProviderScopeInvalid after destroy", async () => {
    const provider = new HostConfigProvider(
      { declaredKey: "value" },
      declaredKeys,
    );
    provider.destroy();
    await expect(provider.get("declaredKey")).rejects.toBeInstanceOf(
      ProviderScopeInvalid,
    );
  });

  it("throws ProviderScopeInvalid for any key after destroy", async () => {
    const provider = new HostConfigProvider({}, declaredKeys);
    provider.destroy();
    await expect(provider.get("undeclared" as never)).rejects.toBeInstanceOf(
      ProviderScopeInvalid,
    );
  });

  it("does not allow reading after destroy even if key was previously readable", async () => {
    const provider = new HostConfigProvider(
      { declaredKey: "value" },
      declaredKeys,
    );
    await expect(provider.get("declaredKey")).resolves.toBe("value");
    provider.destroy();
    await expect(provider.get("declaredKey")).rejects.toBeInstanceOf(
      ProviderScopeInvalid,
    );
  });
});

describe("HostSecretsProvider", () => {
  const schema = {
    type: "object",
    properties: {
      secretKey: { type: "string" },
      optionalSecret: { type: "number" },
    },
  };
  const declaredKeys = declaredSchemaKeys(schema);
  const resolverFor = (values: Record<string, unknown>) => {
    return async (key: string) =>
      Object.hasOwn(values, key) ? values[key] : undefined;
  };

  it("returns value for declared and configured key", async () => {
    const provider = new HostSecretsProvider(
      resolverFor({ secretKey: "secret-value", optionalSecret: 123 }),
      declaredKeys,
    );
    await expect(provider.get("secretKey")).resolves.toBe("secret-value");
    await expect(provider.get("optionalSecret")).resolves.toBe(123);
  });

  it("resolves on demand without retaining plaintext", async () => {
    let calls = 0;
    const provider = new HostSecretsProvider(async (key: string) => {
      calls++;
      return key === "secretKey" ? `value-${calls}` : undefined;
    }, declaredKeys);
    await expect(provider.get("secretKey")).resolves.toBe("value-1");
    await expect(provider.get("secretKey")).resolves.toBe("value-2");
    expect(calls).toBe(2);
  });

  it("throws ProviderKeyNotDeclared for undeclared key", async () => {
    const provider = new HostSecretsProvider(resolverFor({}), declaredKeys);
    await expect(provider.get("undeclared" as never)).rejects.toBeInstanceOf(
      ProviderKeyNotDeclared,
    );
  });

  it("throws ProviderKeyNotConfigured for declared but unconfigured key", async () => {
    const provider = new HostSecretsProvider(resolverFor({}), declaredKeys);
    await expect(provider.get("secretKey")).rejects.toBeInstanceOf(
      ProviderKeyNotConfigured,
    );
  });

  it("throws ProviderScopeInvalid after destroy", async () => {
    const provider = new HostSecretsProvider(
      resolverFor({ secretKey: "value" }),
      declaredKeys,
    );
    provider.destroy();
    await expect(provider.get("secretKey")).rejects.toBeInstanceOf(
      ProviderScopeInvalid,
    );
  });

  it("throws ProviderScopeInvalid for any key after destroy", async () => {
    const provider = new HostSecretsProvider(resolverFor({}), declaredKeys);
    provider.destroy();
    await expect(provider.get("undeclared" as never)).rejects.toBeInstanceOf(
      ProviderScopeInvalid,
    );
  });

  it("does not allow reading after destroy even if key was previously readable", async () => {
    const provider = new HostSecretsProvider(
      resolverFor({ secretKey: "value" }),
      declaredKeys,
    );
    await expect(provider.get("secretKey")).resolves.toBe("value");
    provider.destroy();
    await expect(provider.get("secretKey")).rejects.toBeInstanceOf(
      ProviderScopeInvalid,
    );
  });

  it("wraps resolver failures as SecretDecryptionFailed", async () => {
    const provider = new HostSecretsProvider(async () => {
      throw new Error("decrypt boom");
    }, declaredKeys);
    await expect(provider.get("secretKey")).rejects.toBeInstanceOf(
      SecretDecryptionFailed,
    );
  });
});

describe("ConfiguredValue type behavior", () => {
  it("removes undefined from union for optional properties at runtime", async () => {
    interface Config {
      required: string;
      optional?: number;
    }
    const provider = new HostConfigProvider<Config>(
      { required: "value", optional: 42 },
      new Set(["required", "optional"]),
    );

    const required = await provider.get("required");
    const optional = await provider.get("optional");

    expect(typeof required).toBe("string");
    expect(typeof optional).toBe("number");
  });

  it("preserves null for nullable properties at runtime", async () => {
    interface Config {
      nullable: string | null;
    }
    const provider = new HostConfigProvider<Config>(
      { nullable: null },
      new Set(["nullable"]),
    );

    const value = await provider.get("nullable");
    expect(value).toBeNull();
  });
});
