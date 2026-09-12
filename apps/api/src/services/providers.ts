import type {
  ConfigProvider,
  ConfiguredValue,
  SecretsProvider,
} from "@cyrnel/sdk";

export class ProviderError extends Error {}

export class ProviderKeyNotDeclared extends ProviderError {
  constructor(scope: string, key: string) {
    super(`Key '${key}' is not declared in scope '${scope}'.`);
    this.name = "ProviderKeyNotDeclared";
  }
}

export class ProviderKeyNotConfigured extends ProviderError {
  constructor(scope: string, key: string) {
    super(`Key '${key}' is not configured in scope '${scope}'.`);
    this.name = "ProviderKeyNotConfigured";
  }
}

export class ProviderScopeInvalid extends ProviderError {
  constructor(scope: string) {
    super(`Provider scope '${scope}' is invalid (destroyed).`);
    this.name = "ProviderScopeInvalid";
  }
}

export class ProviderReadFailed extends ProviderError {
  constructor(scope: string, key: string, cause: unknown) {
    super(`Failed to read '${key}' from scope '${scope}'.`);
    this.name = "ProviderReadFailed";
    this.cause = cause;
  }

  readonly cause: unknown;
}

export class SecretDecryptionFailed extends ProviderError {
  constructor(scope: string, key: string, cause: unknown) {
    super(`Failed to decrypt secret '${key}' in scope '${scope}'.`);
    this.name = "SecretDecryptionFailed";
    this.cause = cause;
  }

  readonly cause: unknown;
}

export class CredentialUnavailable extends ProviderError {
  constructor(schemeName: string, scope: string) {
    super(
      `No credential is available for scheme '${schemeName}' in scope '${scope}'.`,
    );
    this.name = "CredentialUnavailable";
  }
}

export class HostConfigProvider<Config extends object = {}>
  implements ConfigProvider<Config>
{
  private destroyed = false;

  constructor(
    private readonly values: Readonly<Record<string, unknown>>,
    private readonly declaredKeys: ReadonlySet<string>,
  ) {}

  async get<K extends keyof Config>(
    key: K,
  ): Promise<ConfiguredValue<Config[K]>> {
    if (this.destroyed) {
      throw new ProviderScopeInvalid("config");
    }
    const rawKey = String(key);
    if (!this.declaredKeys.has(rawKey)) {
      throw new ProviderKeyNotDeclared("config", rawKey);
    }
    if (!Object.hasOwn(this.values, rawKey)) {
      throw new ProviderKeyNotConfigured("config", rawKey);
    }
    return this.values[rawKey] as ConfiguredValue<Config[K]>;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

export class HostSecretsProvider<Secrets extends object = {}>
  implements SecretsProvider<Secrets>
{
  private destroyed = false;

  constructor(
    private readonly resolve: (key: string) => Promise<unknown>,
    private readonly declaredKeys: ReadonlySet<string>,
  ) {}

  async get<K extends keyof Secrets>(
    key: K,
  ): Promise<ConfiguredValue<Secrets[K]>> {
    if (this.destroyed) {
      throw new ProviderScopeInvalid("secrets");
    }
    const rawKey = String(key);
    if (!this.declaredKeys.has(rawKey)) {
      throw new ProviderKeyNotDeclared("secrets", rawKey);
    }
    let value: unknown;
    try {
      value = await this.resolve(rawKey);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new SecretDecryptionFailed("secrets", rawKey, err);
    }
    if (value === undefined) {
      throw new ProviderKeyNotConfigured("secrets", rawKey);
    }
    return value as ConfiguredValue<Secrets[K]>;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

export function declaredSchemaKeys(schema: unknown): ReadonlySet<string> {
  const props =
    typeof schema === "object" && schema !== null
      ? (schema as Record<string, unknown>).properties
      : undefined;
  if (typeof props !== "object" || props === null)
    return Object.freeze(new Set<string>());
  const keys = Object.keys(props as Record<string, unknown>);
  return Object.freeze(new Set<string>(keys));
}
