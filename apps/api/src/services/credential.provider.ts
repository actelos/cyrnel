import type { CredentialProvider, ResolvedCredential } from "@cyrnel/sdk";
import { logger } from "@/infra/logging";
import { HttpError } from "@/models/error.model";
import {
  CredentialService,
  type NormalizedCredential,
  type OwnerCredentialStore,
  TOKEN_EXPIRY_SKEW_MS,
} from "@/services/credential.service";
import { CredentialUnavailable } from "@/services/providers";

interface CredentialScope {
  label: string;
  logFields: Record<string, string>;
  getCredential(
    store: CredentialService,
    schemeName: string,
  ): Promise<NormalizedCredential | null>;
  openStore(store: CredentialService): OwnerCredentialStore;
}

function scopedStore(
  credentials: CredentialService,
  scope: CredentialScope,
): OwnerCredentialStore {
  return scope.openStore(credentials);
}

async function resolveApiKey(
  store: OwnerCredentialStore,
  credential: NormalizedCredential,
  scope: CredentialScope,
): Promise<ResolvedCredential> {
  const auth = await store.getDecryptedAuth(credential.id);
  const apiKey = auth?.apiKey;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new HttpError(
      500,
      `Credential '${credential.id}' has no stored API key.`,
    );
  }
  logger.debug(
    {
      event: "credential-resolved",
      credentialId: credential.id,
      schemeType: "apiKey",
      ...scope.logFields,
      status: "success",
    },
    "Resolved apiKey credential",
  );
  return { type: "apiKey", value: apiKey };
}

async function resolveBasic(
  store: OwnerCredentialStore,
  credential: NormalizedCredential,
  scope: CredentialScope,
): Promise<ResolvedCredential> {
  const auth = await store.getDecryptedAuth(credential.id);
  const username = auth?.username;
  const password = auth?.password;
  if (typeof username !== "string" || typeof password !== "string") {
    throw new HttpError(
      500,
      `Credential '${credential.id}' has incomplete basic credentials.`,
    );
  }
  logger.debug(
    {
      event: "credential-resolved",
      credentialId: credential.id,
      schemeType: "basic",
      ...scope.logFields,
      status: "success",
    },
    "Resolved basic credential",
  );
  return { type: "basic", username, password };
}

async function resolveBearer(
  store: OwnerCredentialStore,
  credential: NormalizedCredential,
  scope: CredentialScope,
): Promise<ResolvedCredential> {
  const auth = await store.getDecryptedAuth(credential.id);
  const token = auth?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new HttpError(
      500,
      `Credential '${credential.id}' has no stored bearer token.`,
    );
  }
  logger.debug(
    {
      event: "credential-resolved",
      credentialId: credential.id,
      schemeType: "bearer",
      ...scope.logFields,
      status: "success",
    },
    "Resolved bearer credential",
  );
  return { type: "bearer", token };
}

async function resolveOAuth2(
  store: OwnerCredentialStore,
  credential: NormalizedCredential,
  scope: CredentialScope,
): Promise<ResolvedCredential> {
  const auth = await store.getDecryptedAuth(credential.id);
  const accessToken = auth?.accessToken as string | undefined;
  const refreshToken = auth?.refreshToken as string | undefined;
  const expiresAt = auth?.expiresAt as number | undefined;

  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new HttpError(
      409,
      `Credential '${credential.id}' has no access token. Complete the OAuth authorization flow first.`,
    );
  }

  const scopes = credential.grantedScopes ?? [];

  const expiring =
    typeof expiresAt !== "number" ||
    expiresAt - TOKEN_EXPIRY_SKEW_MS <= Date.now();
  if (!expiring) {
    logger.debug(
      {
        event: "credential-resolved",
        credentialId: credential.id,
        schemeType: "oauth2",
        ...scope.logFields,
        status: "success",
      },
      "Resolved oauth2 credential",
    );
    return {
      type: "oauth2",
      accessToken,
      expiresAt: expiresAt as number,
      scopes,
    };
  }

  if (!refreshToken) {
    await store.setStatus(credential.id, "expired");
    throw new HttpError(
      409,
      `Credential '${credential.id}' token expired and has no refresh token. Re-authorize the credential.`,
    );
  }

  const refreshed = await store.refreshOAuthToken(credential.id, "on-demand");
  const latest = await store.getCredential(credential.id);
  logger.debug(
    {
      event: "credential-resolved",
      credentialId: credential.id,
      schemeType: "oauth2",
      ...scope.logFields,
      status: "refreshed",
    },
    "Resolved oauth2 credential after on-demand refresh",
  );
  return {
    type: "oauth2",
    accessToken: refreshed.accessToken,
    expiresAt: refreshed.expiresAt,
    scopes: latest?.grantedScopes ?? scopes,
  };
}

async function resolveCredentialInScope(
  credentials: CredentialService,
  scope: CredentialScope,
  schemeName: string,
): Promise<ResolvedCredential> {
  const credential = await scope.getCredential(credentials, schemeName);
  if (!credential) {
    throw new CredentialUnavailable(schemeName, scope.label);
  }
  const store = scopedStore(credentials, scope);

  if (credential.status === "revoked") {
    throw new HttpError(
      409,
      `Credential '${credential.id}' was revoked. Re-authorize the credential.`,
    );
  }

  try {
    switch (credential.schemeType) {
      case "apiKey":
        return await resolveApiKey(store, credential, scope);
      case "basic":
        return await resolveBasic(store, credential, scope);
      case "bearer":
        return await resolveBearer(store, credential, scope);
      case "oauth2":
        return await resolveOAuth2(store, credential, scope);
      default:
        throw new HttpError(
          500,
          `Credential '${credential.id}' has an unsupported scheme type.`,
        );
    }
  } catch (err) {
    logger.warn(
      {
        event: "credential-resolved",
        credentialId: credential.id,
        schemeType: credential.schemeType,
        ...scope.logFields,
        status: "failed",
        err,
      },
      "Failed to resolve credential",
    );
    throw err;
  }
}

export class HostCredentialProvider implements CredentialProvider {
  constructor(
    private readonly serviceId: string,
    private readonly credentials: CredentialService = new CredentialService(),
  ) {}

  async getCredential(schemeName: string): Promise<ResolvedCredential> {
    return resolveCredentialInScope(
      this.credentials,
      {
        label: this.serviceId,
        logFields: { serviceId: this.serviceId },
        getCredential: (credentials, scheme) =>
          credentials.forService(this.serviceId).getForScheme(scheme),
        openStore: (credentials) => credentials.forService(this.serviceId),
      },
      schemeName,
    );
  }
}

export class ModuleCredentialProvider implements CredentialProvider {
  constructor(
    private readonly moduleId: string,
    private readonly credentials: CredentialService = new CredentialService(),
  ) {}

  async getCredential(schemeName: string): Promise<ResolvedCredential> {
    return resolveCredentialInScope(
      this.credentials,
      {
        label: `module '${this.moduleId}'`,
        logFields: { moduleId: this.moduleId },
        getCredential: (credentials, scheme) =>
          credentials.forModule(this.moduleId).getForScheme(scheme),
        openStore: (credentials) => credentials.forModule(this.moduleId),
      },
      schemeName,
    );
  }
}

export class RegistryCredentialProvider implements CredentialProvider {
  constructor(
    private readonly registryId: string,
    private readonly credentials: CredentialService = new CredentialService(),
  ) {}

  async getCredential(schemeName: string): Promise<ResolvedCredential> {
    return resolveCredentialInScope(
      this.credentials,
      {
        label: `registry '${this.registryId}'`,
        logFields: { registryId: this.registryId },
        getCredential: (credentials, scheme) =>
          credentials.forRegistry(this.registryId).getForScheme(scheme),
        openStore: (credentials) => credentials.forRegistry(this.registryId),
      },
      schemeName,
    );
  }
}
