import crypto, { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  moduleCredentialAuth,
  moduleCredentials,
  modules,
  oauthClients,
  oauthPendings,
  registries,
  registryCredentialAuth,
  registryCredentials,
  serviceCredentialAuth,
  serviceCredentials,
  services,
} from "@/db/schema";
import { logger } from "@/infra/logging";
import { HttpError } from "@/models/error.model";
import type { EncryptedSecretsPayload } from "@/models/secrets.model";
import { decryptSecrets, encryptSecrets } from "@/utils/secrets.util";

export const TOKEN_EXPIRY_SKEW_MS = 30_000;
const TOKEN_ENDPOINT_TIMEOUT_MS = 10_000;

export type OwnerKind = "service" | "module" | "registry";
export type CredentialSchemeType = "apiKey" | "basic" | "bearer" | "oauth2";
export type CredentialStatus = "active" | "expired" | "revoked" | "error";

function ownerLabel(kind: OwnerKind, ownerId: string): string {
  return `${kind} '${ownerId}'`;
}

function isCompatibleWithScheme(
  credentialType: string,
  scheme: { type?: string; scheme?: string },
): boolean {
  if (credentialType === "apiKey") return scheme.type === "apiKey";
  if (credentialType === "basic")
    return (
      scheme.type === "basic" ||
      (scheme.type === "http" && scheme.scheme === "basic")
    );
  if (credentialType === "bearer")
    return scheme.type === "http" && scheme.scheme === "bearer";
  if (credentialType === "oauth2") return scheme.type === "oauth2";
  return false;
}

function requiredSchemeLabel(scheme: {
  type?: string;
  scheme?: string;
}): string {
  if (scheme.type === "http" && typeof scheme.scheme === "string") {
    return `http/${scheme.scheme}`;
  }
  return (scheme.type ?? "unknown") as string;
}

function getDefaultOAuthRedirectBase(): string {
  return process.env.CYRNEL_OAUTH_REDIRECT_BASE ?? "http://localhost:9371";
}

export type TokenRefreshType = "on-demand" | "background";

export interface NormalizedCredential {
  id: string;
  kind: OwnerKind;
  ownerId: string;
  schemeName: string;
  schemeType: CredentialSchemeType;
  status: CredentialStatus;
  oauthClientId: string | null;
  requestedScopes: string[];
  grantedScopes: string[] | null;
  grantedSource: "provider" | "inferred" | null;
  createdAt: string;
  updatedAt: string;
}

export interface OAuthClientPublic {
  id: string;
  provider: string;
  clientId: string;
  tokenUrl: string;
  authorizationUrl: string | null;
  clientAuthMethod: string;
  redirectUris: string[];
  availableScopes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CredentialSummary extends NormalizedCredential {
  oauthClient: {
    id: string;
    provider: string;
    clientId: string;
    tokenUrl: string;
    authorizationUrl: string | null;
  } | null;
}

export interface OAuthAuthorization {
  authorizationUrl: string;
  state: string;
}

interface OAuthTokenState {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

interface InFlightRefreshEntry {
  promise: Promise<OAuthTokenState>;
}

const inFlightRefreshes = new Map<string, InFlightRefreshEntry>();

export function invalidateCredentialAuthCache(): void {
  inFlightRefreshes.clear();
}

type ServiceCredentialRow = typeof serviceCredentials.$inferSelect;
type ModuleCredentialRow = typeof moduleCredentials.$inferSelect;
type RegistryCredentialRow = typeof registryCredentials.$inferSelect;

function normalizeRow(
  kind: OwnerKind,
  ownerId: string,
  row: ServiceCredentialRow | ModuleCredentialRow | RegistryCredentialRow,
): NormalizedCredential {
  return {
    id: row.id,
    kind,
    ownerId,
    schemeName: row.schemeName,
    schemeType: row.schemeType,
    status: row.status,
    oauthClientId: row.oauthClientId,
    requestedScopes: row.requestedScopes ?? [],
    grantedScopes: row.grantedScopes,
    grantedSource: row.grantedSource,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function readDeclaredSchemes(
  kind: OwnerKind,
  ownerId: string,
): Promise<Record<string, { type?: string; scheme?: string }>> {
  if (kind === "service") {
    const [row] = await db
      .select({ id: services.id, schemes: services.schemes })
      .from(services)
      .where(eq(services.id, ownerId))
      .limit(1);
    if (!row) throw new HttpError(404, `Service '${ownerId}' not found.`);
    return (
      (row.schemes as Record<string, { type?: string; scheme?: string }>) ?? {}
    );
  }
  if (kind === "module") {
    const [row] = await db
      .select({ id: modules.id, schemes: modules.schemes })
      .from(modules)
      .where(eq(modules.id, ownerId))
      .limit(1);
    if (!row) throw new HttpError(404, `Module '${ownerId}' not found.`);
    return (
      (row.schemes as Record<string, { type?: string; scheme?: string }>) ?? {}
    );
  }
  const [row] = await db
    .select({ id: registries.id, baseUrl: registries.baseUrl })
    .from(registries)
    .where(eq(registries.id, ownerId))
    .limit(1);
  if (!row) throw new HttpError(404, `Registry '${ownerId}' not found.`);
  const { fetchRegistryIndex } = await import("@/utils/registry.util");
  const index = await fetchRegistryIndex(row.baseUrl);
  const schemes: Record<string, { type?: string; scheme?: string }> = {};
  const declared = index.auth?.schemes;
  if (declared) {
    for (const [name, scheme] of Object.entries(declared)) {
      schemes[name] = {
        type: scheme.type,
        scheme: "scheme" in scheme ? scheme.scheme : undefined,
      };
    }
  }
  return schemes;
}

function assertSchemeCompatible(
  kind: OwnerKind,
  ownerId: string,
  credentialType: CredentialSchemeType,
  schemeName: string,
  schemes: Record<string, { type?: string; scheme?: string }>,
): void {
  const scheme = Object.hasOwn(schemes, schemeName)
    ? schemes[schemeName]
    : undefined;
  if (!scheme) {
    throw new HttpError(
      400,
      `Scheme '${schemeName}' is not declared by ${ownerLabel(kind, ownerId)}.`,
    );
  }
  if (!isCompatibleWithScheme(credentialType, scheme)) {
    throw new HttpError(
      400,
      `Scheme '${schemeName}' requires '${requiredSchemeLabel(scheme)}' but the credential is '${credentialType}'.`,
    );
  }
}

export function parseGrantedScopes(
  respBody: Record<string, unknown>,
  requested: string[],
): { scopes: string[]; source: "provider" | "inferred" } {
  const raw = respBody.scope;
  if (typeof raw === "string") {
    return {
      scopes: raw
        .split(" ")
        .map((s) => s.trim())
        .filter(Boolean),
      source: "provider",
    };
  }
  if (Array.isArray(raw) && raw.every((entry) => typeof entry === "string")) {
    return {
      scopes: (raw as string[]).map((s) => s.trim()).filter(Boolean),
      source: "provider",
    };
  }
  return { scopes: [...requested], source: "inferred" };
}

export function normalizeAuthUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new HttpError(400, `Invalid URL '${raw}'.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, `URL '${raw}' must use http(s).`);
  }
  const scheme = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const defaultPort =
    (scheme === "https:" && parsed.port === "443") ||
    (scheme === "http:" && parsed.port === "80");
  const port = parsed.port && !defaultPort ? `:${parsed.port}` : "";
  let path = parsed.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return `${scheme}//${host}${port}${path}`;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return (
      ua.protocol.toLowerCase() === ub.protocol.toLowerCase() &&
      ua.hostname.toLowerCase() === ub.hostname.toLowerCase() &&
      (ua.port || (ua.protocol === "https:" ? "443" : "80")) ===
        (ub.port || (ub.protocol === "https:" ? "443" : "80"))
    );
  } catch {
    return false;
  }
}

export interface ResolvedOAuthClient extends OAuthClientPublic {
  scopeCompatible: boolean;
  tokenHost: string | null;
  warning: string | null;
}

async function publicClient(
  row: typeof oauthClients.$inferSelect,
): Promise<OAuthClientPublic> {
  return {
    id: row.id,
    provider: row.provider,
    clientId: row.clientId,
    tokenUrl: row.tokenUrl,
    authorizationUrl: row.authorizationUrl,
    clientAuthMethod: row.clientAuthMethod,
    redirectUris: row.redirectUris,
    availableScopes: row.availableScopes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class OwnerCredentialStore {
  constructor(
    readonly kind: OwnerKind,
    readonly ownerId: string,
    private readonly service: CredentialService,
  ) {}

  private get label(): string {
    return ownerLabel(this.kind, this.ownerId);
  }

  async getCredential(
    credentialId: string,
  ): Promise<NormalizedCredential | null> {
    if (this.kind === "service") {
      const [row] = await db
        .select()
        .from(serviceCredentials)
        .where(
          and(
            eq(serviceCredentials.id, credentialId),
            eq(serviceCredentials.serviceId, this.ownerId),
          ),
        )
        .limit(1);
      return row ? normalizeRow(this.kind, this.ownerId, row) : null;
    }
    if (this.kind === "module") {
      const [row] = await db
        .select()
        .from(moduleCredentials)
        .where(
          and(
            eq(moduleCredentials.id, credentialId),
            eq(moduleCredentials.moduleId, this.ownerId),
          ),
        )
        .limit(1);
      return row ? normalizeRow(this.kind, this.ownerId, row) : null;
    }
    const [row] = await db
      .select()
      .from(registryCredentials)
      .where(
        and(
          eq(registryCredentials.id, credentialId),
          eq(registryCredentials.registryId, this.ownerId),
        ),
      )
      .limit(1);
    return row ? normalizeRow(this.kind, this.ownerId, row) : null;
  }

  async getForScheme(schemeName: string): Promise<NormalizedCredential | null> {
    if (this.kind === "service") {
      const [row] = await db
        .select()
        .from(serviceCredentials)
        .where(
          and(
            eq(serviceCredentials.serviceId, this.ownerId),
            eq(serviceCredentials.schemeName, schemeName),
          ),
        )
        .limit(1);
      return row ? normalizeRow(this.kind, this.ownerId, row) : null;
    }
    if (this.kind === "module") {
      const [row] = await db
        .select()
        .from(moduleCredentials)
        .where(
          and(
            eq(moduleCredentials.moduleId, this.ownerId),
            eq(moduleCredentials.schemeName, schemeName),
          ),
        )
        .limit(1);
      return row ? normalizeRow(this.kind, this.ownerId, row) : null;
    }
    const [row] = await db
      .select()
      .from(registryCredentials)
      .where(
        and(
          eq(registryCredentials.registryId, this.ownerId),
          eq(registryCredentials.schemeName, schemeName),
        ),
      )
      .limit(1);
    return row ? normalizeRow(this.kind, this.ownerId, row) : null;
  }

  async listCredentials(): Promise<CredentialSummary[]> {
    const creds = await this.service.listOwnedCredentials(
      this.kind,
      this.ownerId,
    );
    const summaries: CredentialSummary[] = [];
    for (const cred of creds) {
      summaries.push(await this.service.toSummary(cred));
    }
    return summaries;
  }

  private async upsertShell(input: {
    schemeName: string;
    schemeType: CredentialSchemeType;
    oauthClientId: string | null;
    requestedScopes: string[];
    payload: Record<string, unknown>;
  }): Promise<{ credential: NormalizedCredential; replaced: boolean }> {
    const schemes = await readDeclaredSchemes(this.kind, this.ownerId);
    assertSchemeCompatible(
      this.kind,
      this.ownerId,
      input.schemeType,
      input.schemeName,
      schemes,
    );
    const existing = await this.getForScheme(input.schemeName);
    const now = new Date().toISOString();
    const encrypted = encryptSecrets(input.payload);

    if (existing) {
      const authUpdatedAt = Date.now();
      await db.transaction(async (tx) => {
        if (this.kind === "service") {
          await tx
            .update(serviceCredentials)
            .set({
              schemeType: input.schemeType,
              status: "active",
              oauthClientId: input.oauthClientId,
              requestedScopes: input.requestedScopes,
              grantedScopes: null,
              grantedSource: null,
              updatedAt: now,
            })
            .where(eq(serviceCredentials.id, existing.id));
          await tx
            .update(serviceCredentialAuth)
            .set({
              schemeType: input.schemeType,
              payload: encrypted,
              updatedAt: authUpdatedAt,
            })
            .where(eq(serviceCredentialAuth.credentialId, existing.id));
        } else if (this.kind === "module") {
          await tx
            .update(moduleCredentials)
            .set({
              schemeType: input.schemeType,
              status: "active",
              oauthClientId: input.oauthClientId,
              requestedScopes: input.requestedScopes,
              grantedScopes: null,
              grantedSource: null,
              updatedAt: now,
            })
            .where(eq(moduleCredentials.id, existing.id));
          await tx
            .update(moduleCredentialAuth)
            .set({
              schemeType: input.schemeType,
              payload: encrypted,
              updatedAt: authUpdatedAt,
            })
            .where(eq(moduleCredentialAuth.credentialId, existing.id));
        } else {
          await tx
            .update(registryCredentials)
            .set({
              schemeType: input.schemeType,
              status: "active",
              oauthClientId: input.oauthClientId,
              requestedScopes: input.requestedScopes,
              grantedScopes: null,
              grantedSource: null,
              updatedAt: now,
            })
            .where(eq(registryCredentials.id, existing.id));
          await tx
            .update(registryCredentialAuth)
            .set({
              schemeType: input.schemeType,
              payload: encrypted,
              updatedAt: authUpdatedAt,
            })
            .where(eq(registryCredentialAuth.credentialId, existing.id));
        }
      });
      await this.service.deletePendingsFor(existing.id);
      const updated = await this.getCredential(existing.id);
      if (!updated) {
        throw new HttpError(500, `Credential '${existing.id}' vanished.`);
      }
      logger.debug(
        {
          event: "credential-replaced",
          credentialId: existing.id,
          schemeType: input.schemeType,
        },
        `Replaced ${this.label} credential for scheme '${input.schemeName}'`,
      );
      return { credential: updated, replaced: true };
    }

    const id = randomUUID();
    const authCreatedAt = Date.now();
    await db.transaction(async (tx) => {
      if (this.kind === "service") {
        await tx.insert(serviceCredentials).values({
          id,
          serviceId: this.ownerId,
          schemeName: input.schemeName,
          schemeType: input.schemeType,
          status: "active",
          oauthClientId: input.oauthClientId,
          requestedScopes: input.requestedScopes,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(serviceCredentialAuth).values({
          credentialId: id,
          schemeType: input.schemeType,
          payload: encrypted,
          updatedAt: authCreatedAt,
        });
      } else if (this.kind === "module") {
        await tx.insert(moduleCredentials).values({
          id,
          moduleId: this.ownerId,
          schemeName: input.schemeName,
          schemeType: input.schemeType,
          status: "active",
          oauthClientId: input.oauthClientId,
          requestedScopes: input.requestedScopes,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(moduleCredentialAuth).values({
          credentialId: id,
          schemeType: input.schemeType,
          payload: encrypted,
          updatedAt: authCreatedAt,
        });
      } else {
        await tx.insert(registryCredentials).values({
          id,
          registryId: this.ownerId,
          schemeName: input.schemeName,
          schemeType: input.schemeType,
          status: "active",
          oauthClientId: input.oauthClientId,
          requestedScopes: input.requestedScopes,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(registryCredentialAuth).values({
          credentialId: id,
          schemeType: input.schemeType,
          payload: encrypted,
          updatedAt: authCreatedAt,
        });
      }
    });
    const created = await this.getCredential(id);
    if (!created) {
      throw new HttpError(500, `Credential '${id}' vanished.`);
    }
    logger.debug(
      {
        event: "credential-created",
        credentialId: id,
        schemeType: input.schemeType,
      },
      `Created ${this.label} credential for scheme '${input.schemeName}'`,
    );
    return { credential: created, replaced: false };
  }

  async upsertApiKey(
    schemeName: string,
    apiKey: string,
  ): Promise<{ credential: NormalizedCredential; replaced: boolean }> {
    return this.upsertShell({
      schemeName,
      schemeType: "apiKey",
      oauthClientId: null,
      requestedScopes: [],
      payload: { apiKey },
    });
  }

  async upsertBasic(
    schemeName: string,
    username: string,
    password: string,
  ): Promise<{ credential: NormalizedCredential; replaced: boolean }> {
    return this.upsertShell({
      schemeName,
      schemeType: "basic",
      oauthClientId: null,
      requestedScopes: [],
      payload: { username, password },
    });
  }

  async upsertBearer(
    schemeName: string,
    token: string,
  ): Promise<{ credential: NormalizedCredential; replaced: boolean }> {
    return this.upsertShell({
      schemeName,
      schemeType: "bearer",
      oauthClientId: null,
      requestedScopes: [],
      payload: { token },
    });
  }

  async upsertOAuth2(
    schemeName: string,
    oauthClientId: string,
    scopes: string[],
  ): Promise<{
    credential: NormalizedCredential;
    replaced: boolean;
    unknownScopes: string[];
  }> {
    const client = await this.service.getOAuthClient(oauthClientId);
    if (!client) {
      throw new HttpError(404, `OAuth client '${oauthClientId}' not found.`);
    }
    const unknown = scopes.filter((s) => !client.availableScopes.includes(s));
    if (unknown.length > 0) {
      throw new HttpError(
        400,
        `Requested scope(s) not available on OAuth client '${oauthClientId}': ${unknown.join(", ")}.`,
      );
    }
    const schemes = await readDeclaredSchemes(this.kind, this.ownerId);
    const declared = schemes[schemeName] as
      | { type?: string; scopes?: Record<string, string> }
      | undefined;
    const declaredKeys =
      declared && typeof declared === "object" && declared.scopes
        ? Object.keys(declared.scopes)
        : null;
    const unknownScopes =
      declaredKeys === null
        ? []
        : scopes.filter((s) => !declaredKeys.includes(s));
    const { credential, replaced } = await this.upsertShell({
      schemeName,
      schemeType: "oauth2",
      oauthClientId,
      requestedScopes: scopes,
      payload: {},
    });
    return { credential, replaced, unknownScopes };
  }

  async disconnectScheme(schemeName: string): Promise<boolean> {
    const existing = await this.getForScheme(schemeName);
    if (!existing) return false;
    await this.service.deleteCredential(this.kind, existing.id);
    logger.info(
      { event: "credential-disconnected", credentialId: existing.id },
      `Disconnected ${this.label} scheme '${schemeName}'`,
    );
    return true;
  }

  async getDecryptedAuth(
    credentialId: string,
  ): Promise<Record<string, unknown> | null> {
    const cred = await this.getCredential(credentialId);
    if (!cred) return null;
    let rows: Array<{ schemeType: string; payload: unknown }> = [];
    if (this.kind === "service") {
      rows = await db
        .select({
          schemeType: serviceCredentialAuth.schemeType,
          payload: serviceCredentialAuth.payload,
        })
        .from(serviceCredentialAuth)
        .where(eq(serviceCredentialAuth.credentialId, credentialId))
        .limit(1);
    } else if (this.kind === "module") {
      rows = await db
        .select({
          schemeType: moduleCredentialAuth.schemeType,
          payload: moduleCredentialAuth.payload,
        })
        .from(moduleCredentialAuth)
        .where(eq(moduleCredentialAuth.credentialId, credentialId))
        .limit(1);
    } else {
      rows = await db
        .select({
          schemeType: registryCredentialAuth.schemeType,
          payload: registryCredentialAuth.payload,
        })
        .from(registryCredentialAuth)
        .where(eq(registryCredentialAuth.credentialId, credentialId))
        .limit(1);
    }
    const row = rows[0];
    if (!row) return null;
    if (row.schemeType !== cred.schemeType) {
      logger.warn(
        {
          event: "credential-scheme-mismatch",
          credentialId,
          credentialType: cred.schemeType,
          authType: row.schemeType,
        },
        "Credential scheme type disagrees with its secrets row; refusing to use either",
      );
      throw new HttpError(
        500,
        `Credential '${credentialId}' has inconsistent scheme types.`,
      );
    }
    return decryptSecrets(row.payload as EncryptedSecretsPayload);
  }

  async setStatus(
    credentialId: string,
    status: CredentialStatus,
  ): Promise<void> {
    const now = new Date().toISOString();
    if (this.kind === "service") {
      await db
        .update(serviceCredentials)
        .set({ status, updatedAt: now })
        .where(eq(serviceCredentials.id, credentialId));
    } else if (this.kind === "module") {
      await db
        .update(moduleCredentials)
        .set({ status, updatedAt: now })
        .where(eq(moduleCredentials.id, credentialId));
    } else {
      await db
        .update(registryCredentials)
        .set({ status, updatedAt: now })
        .where(eq(registryCredentials.id, credentialId));
    }
  }

  async beginOAuth(schemeName: string): Promise<OAuthAuthorization> {
    const cred = await this.getForScheme(schemeName);
    if (!cred) {
      throw new HttpError(
        404,
        `No credential configured for scheme '${schemeName}' on ${this.label}.`,
      );
    }
    if (cred.schemeType !== "oauth2" || !cred.oauthClientId) {
      throw new HttpError(
        400,
        `Scheme '${schemeName}' on ${this.label} is not an OAuth2 credential.`,
      );
    }
    const client = await this.service.getOAuthClientRow(cred.oauthClientId);
    if (!client) {
      throw new HttpError(
        404,
        `OAuth client for ${this.label} scheme '${schemeName}' not found.`,
      );
    }
    if (!client.authorizationUrl) {
      throw new HttpError(
        400,
        `OAuth client '${client.id}' has no authorization URL configured.`,
      );
    }
    const state = crypto.randomUUID();
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    const redirectUri =
      client.redirectUris?.[0] ??
      `${getDefaultOAuthRedirectBase()}/auth/callback`;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: redirectUri,
      scope: cred.requestedScopes.join(" "),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    const authorizeUrl = new URL(client.authorizationUrl);
    for (const [key, value] of params) {
      authorizeUrl.searchParams.set(key, value);
    }
    const authorizationUrl = authorizeUrl.toString();
    const now = Date.now();
    await db.insert(oauthPendings).values({
      state,
      serviceCredentialId: this.kind === "service" ? cred.id : null,
      moduleCredentialId: this.kind === "module" ? cred.id : null,
      registryCredentialId: this.kind === "registry" ? cred.id : null,
      codeVerifier,
      codeChallenge,
      redirectUri,
      requestedScopes: cred.requestedScopes,
      createdAt: now,
      expiresAt: now + 10 * 60 * 1000,
    });
    logger.debug(
      { event: "oauth-authorization-begun", credentialId: cred.id, state },
      "Began OAuth authorization flow",
    );
    return { authorizationUrl, state };
  }

  async completeOAuthCode(
    credentialId: string,
    code: string,
    state?: string,
  ): Promise<void> {
    const cred = await this.getCredential(credentialId);
    if (!cred) {
      throw new HttpError(404, `Credential '${credentialId}' not found.`);
    }
    if (state) {
      const pending = await this.service.getPending(state);
      if (!pending || pending.credential.id !== credentialId) {
        throw new HttpError(400, "Invalid or expired authorization state.");
      }
      await this.service.completeOAuthAuthorization(pending.state, code);
      return;
    }
    const pendings = await this.service.listPendingsFor(
      this.kind,
      credentialId,
    );
    const now = Date.now();
    const unexpired = pendings
      .filter((row) => row.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt);
    const latest = unexpired[0];
    if (!latest) {
      throw new HttpError(
        400,
        `No pending authorization found for credential '${credentialId}'. Start a new authorization flow first.`,
      );
    }
    if (unexpired.length > 1) {
      throw new HttpError(
        400,
        `Multiple pending authorizations exist for credential '${credentialId}'. Resubmit with an explicit 'state' to select the flow the code belongs to.`,
      );
    }
    await this.service.completeOAuthAuthorization(latest.state, code);
  }

  async refreshOAuthToken(
    credentialId: string,
    refreshType: TokenRefreshType = "on-demand",
  ): Promise<OAuthTokenState> {
    const key = `${this.kind}:${credentialId}`;
    const existing = inFlightRefreshes.get(key);
    if (existing) return existing.promise;
    const promise = this.service
      .executeRefresh(this.kind, this.ownerId, credentialId, refreshType)
      .finally(() => {
        const current = inFlightRefreshes.get(key);
        if (current && current.promise === promise) {
          inFlightRefreshes.delete(key);
        }
      });
    inFlightRefreshes.set(key, { promise });
    return promise;
  }
}

export interface PendingView {
  state: string;
  credential: NormalizedCredential;
  codeVerifier: string;
  redirectUri: string;
  requestedScopes: string[];
  createdAt: number;
  expiresAt: number;
}

export class CredentialService {
  forService(serviceId: string): OwnerCredentialStore {
    return new OwnerCredentialStore("service", serviceId, this);
  }

  forModule(moduleId: string): OwnerCredentialStore {
    return new OwnerCredentialStore("module", moduleId, this);
  }

  forRegistry(registryId: string): OwnerCredentialStore {
    return new OwnerCredentialStore("registry", registryId, this);
  }

  async listOwnedCredentials(
    kind: OwnerKind,
    ownerId: string,
  ): Promise<NormalizedCredential[]> {
    if (kind === "service") {
      const rows = await db
        .select()
        .from(serviceCredentials)
        .where(eq(serviceCredentials.serviceId, ownerId));
      return rows.map((row) => normalizeRow(kind, ownerId, row));
    }
    if (kind === "module") {
      const rows = await db
        .select()
        .from(moduleCredentials)
        .where(eq(moduleCredentials.moduleId, ownerId));
      return rows.map((row) => normalizeRow(kind, ownerId, row));
    }
    const rows = await db
      .select()
      .from(registryCredentials)
      .where(eq(registryCredentials.registryId, ownerId));
    return rows.map((row) => normalizeRow(kind, ownerId, row));
  }

  async toSummary(cred: NormalizedCredential): Promise<CredentialSummary> {
    if (!cred.oauthClientId) return { ...cred, oauthClient: null };
    const client = await this.getOAuthClientRow(cred.oauthClientId);
    if (!client) {
      throw new HttpError(
        404,
        `OAuth client '${cred.oauthClientId}' referenced by credential '${cred.id}' not found.`,
      );
    }
    return {
      ...cred,
      oauthClient: {
        id: client.id,
        provider: client.provider,
        clientId: client.clientId,
        tokenUrl: client.tokenUrl,
        authorizationUrl: client.authorizationUrl,
      },
    };
  }

  async deleteCredential(kind: OwnerKind, credentialId: string): Promise<void> {
    await db.transaction(async (tx) => {
      if (kind === "service") {
        await tx
          .delete(serviceCredentialAuth)
          .where(eq(serviceCredentialAuth.credentialId, credentialId));
        await tx
          .delete(oauthPendings)
          .where(eq(oauthPendings.serviceCredentialId, credentialId));
        await tx
          .delete(serviceCredentials)
          .where(eq(serviceCredentials.id, credentialId));
      } else if (kind === "module") {
        await tx
          .delete(moduleCredentialAuth)
          .where(eq(moduleCredentialAuth.credentialId, credentialId));
        await tx
          .delete(oauthPendings)
          .where(eq(oauthPendings.moduleCredentialId, credentialId));
        await tx
          .delete(moduleCredentials)
          .where(eq(moduleCredentials.id, credentialId));
      } else {
        await tx
          .delete(registryCredentialAuth)
          .where(eq(registryCredentialAuth.credentialId, credentialId));
        await tx
          .delete(oauthPendings)
          .where(eq(oauthPendings.registryCredentialId, credentialId));
        await tx
          .delete(registryCredentials)
          .where(eq(registryCredentials.id, credentialId));
      }
    });
    inFlightRefreshes.delete(`${kind}:${credentialId}`);
  }

  async deletePendingsFor(credentialId: string): Promise<void> {
    await db
      .delete(oauthPendings)
      .where(eq(oauthPendings.serviceCredentialId, credentialId));
    await db
      .delete(oauthPendings)
      .where(eq(oauthPendings.moduleCredentialId, credentialId));
    await db
      .delete(oauthPendings)
      .where(eq(oauthPendings.registryCredentialId, credentialId));
  }

  async listActiveOAuthCredentials(): Promise<
    Array<{ kind: OwnerKind; ownerId: string; id: string }>
  > {
    const [serviceRows, moduleRows, registryRows] = await Promise.all([
      db
        .select({
          id: serviceCredentials.id,
          ownerId: serviceCredentials.serviceId,
        })
        .from(serviceCredentials)
        .where(
          and(
            eq(serviceCredentials.schemeType, "oauth2"),
            eq(serviceCredentials.status, "active"),
          ),
        ),
      db
        .select({
          id: moduleCredentials.id,
          ownerId: moduleCredentials.moduleId,
        })
        .from(moduleCredentials)
        .where(
          and(
            eq(moduleCredentials.schemeType, "oauth2"),
            eq(moduleCredentials.status, "active"),
          ),
        ),
      db
        .select({
          id: registryCredentials.id,
          ownerId: registryCredentials.registryId,
        })
        .from(registryCredentials)
        .where(
          and(
            eq(registryCredentials.schemeType, "oauth2"),
            eq(registryCredentials.status, "active"),
          ),
        ),
    ]);
    return [
      ...serviceRows.map((r) => ({
        kind: "service" as OwnerKind,
        ownerId: r.ownerId,
        id: r.id,
      })),
      ...moduleRows.map((r) => ({
        kind: "module" as OwnerKind,
        ownerId: r.ownerId,
        id: r.id,
      })),
      ...registryRows.map((r) => ({
        kind: "registry" as OwnerKind,
        ownerId: r.ownerId,
        id: r.id,
      })),
    ];
  }

  async getOAuthClientRow(id: string) {
    const [row] = await db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, id))
      .limit(1);
    return row ?? null;
  }

  async getOAuthClient(id: string): Promise<OAuthClientPublic | null> {
    const row = await this.getOAuthClientRow(id);
    return row ? publicClient(row) : null;
  }

  async createOAuthClient(input: {
    provider: string;
    clientId: string;
    clientSecret: string;
    tokenUrl: string;
    authorizationUrl?: string | null;
    clientAuthMethod?: string;
    redirectUris?: string[];
    availableScopes: string[];
  }): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db.insert(oauthClients).values({
      id,
      provider: input.provider,
      clientId: input.clientId,
      clientSecret: encryptSecrets({ clientSecret: input.clientSecret }),
      tokenUrl: input.tokenUrl,
      authorizationUrl: input.authorizationUrl ?? null,
      clientAuthMethod: input.clientAuthMethod ?? "client_secret_basic",
      redirectUris: input.redirectUris ?? [],
      availableScopes: input.availableScopes,
      createdAt: now,
      updatedAt: now,
    });
    logger.debug(
      { event: "oauth-client-created", clientId: id },
      "Created OAuth client",
    );
    return id;
  }

  async patchOAuthClient(
    id: string,
    input: {
      provider?: string;
      tokenUrl?: string;
      authorizationUrl?: string | null;
      clientAuthMethod?: string;
      redirectUris?: string[];
      availableScopes?: string[];
    },
  ): Promise<OAuthClientPublic> {
    const existing = await this.getOAuthClientRow(id);
    if (!existing) throw new HttpError(404, `OAuth client '${id}' not found.`);
    await db
      .update(oauthClients)
      .set({
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.tokenUrl !== undefined ? { tokenUrl: input.tokenUrl } : {}),
        ...(input.authorizationUrl !== undefined
          ? { authorizationUrl: input.authorizationUrl }
          : {}),
        ...(input.clientAuthMethod !== undefined
          ? { clientAuthMethod: input.clientAuthMethod }
          : {}),
        ...(input.redirectUris !== undefined
          ? { redirectUris: input.redirectUris }
          : {}),
        ...(input.availableScopes !== undefined
          ? { availableScopes: input.availableScopes }
          : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(oauthClients.id, id));
    const updated = await this.getOAuthClient(id);
    if (!updated) throw new HttpError(404, `OAuth client '${id}' not found.`);
    return updated;
  }

  async listOAuthClients(): Promise<OAuthClientPublic[]> {
    const rows = await db
      .select({
        id: oauthClients.id,
        provider: oauthClients.provider,
        clientId: oauthClients.clientId,
        tokenUrl: oauthClients.tokenUrl,
        authorizationUrl: oauthClients.authorizationUrl,
        clientAuthMethod: oauthClients.clientAuthMethod,
        redirectUris: oauthClients.redirectUris,
        availableScopes: oauthClients.availableScopes,
        createdAt: oauthClients.createdAt,
        updatedAt: oauthClients.updatedAt,
      })
      .from(oauthClients);
    return rows;
  }

  async deleteOAuthClient(id: string): Promise<void> {
    const refs: string[] = [];
    const [s, m, r] = await Promise.all([
      db
        .select({
          ownerId: serviceCredentials.serviceId,
          schemeName: serviceCredentials.schemeName,
        })
        .from(serviceCredentials)
        .where(eq(serviceCredentials.oauthClientId, id))
        .limit(5),
      db
        .select({
          ownerId: moduleCredentials.moduleId,
          schemeName: moduleCredentials.schemeName,
        })
        .from(moduleCredentials)
        .where(eq(moduleCredentials.oauthClientId, id))
        .limit(5),
      db
        .select({
          ownerId: registryCredentials.registryId,
          schemeName: registryCredentials.schemeName,
        })
        .from(registryCredentials)
        .where(eq(registryCredentials.oauthClientId, id))
        .limit(5),
    ]);
    for (const row of s)
      refs.push(`service '${row.ownerId}' scheme '${row.schemeName}'`);
    for (const row of m)
      refs.push(`module '${row.ownerId}' scheme '${row.schemeName}'`);
    for (const row of r)
      refs.push(`registry '${row.ownerId}' scheme '${row.schemeName}'`);
    if (refs.length > 0) {
      throw new HttpError(
        409,
        `OAuth client '${id}' is still referenced by ${refs.join(", ")}. Disconnect those schemes first.`,
      );
    }
    await db.delete(oauthClients).where(eq(oauthClients.id, id));
    logger.info(
      { event: "oauth-client-deleted", clientId: id },
      "Deleted OAuth client",
    );
  }

  async resolveOAuthClients(input: {
    authorizationUrl: string;
    requestedScopes?: string[];
  }): Promise<ResolvedOAuthClient[]> {
    const target = normalizeAuthUrl(input.authorizationUrl);
    const clients = await this.listOAuthClients();
    const candidates: ResolvedOAuthClient[] = [];
    for (const client of clients) {
      if (!client.authorizationUrl) continue;
      let normalized: string;
      try {
        normalized = normalizeAuthUrl(client.authorizationUrl);
      } catch {
        continue;
      }
      if (normalized !== target) continue;
      if (!sameOrigin(client.authorizationUrl, client.tokenUrl)) {
        candidates.push({
          ...client,
          scopeCompatible: false,
          tokenHost: safeHost(client.tokenUrl),
          warning:
            "Authorization and token endpoints differ in origin; excluded from automatic selection.",
        });
        continue;
      }
      const scopeCompatible = (input.requestedScopes ?? []).every((s) =>
        client.availableScopes.includes(s),
      );
      candidates.push({
        ...client,
        scopeCompatible,
        tokenHost: safeHost(client.tokenUrl),
        warning: null,
      });
    }
    candidates.sort((a, b) => {
      if (a.warning !== null && b.warning === null) return 1;
      if (a.warning === null && b.warning !== null) return -1;
      if (a.scopeCompatible !== b.scopeCompatible)
        return a.scopeCompatible ? -1 : 1;
      return b.createdAt.localeCompare(a.createdAt);
    });
    return candidates;
  }

  async getPending(state: string): Promise<PendingView | null> {
    const [row] = await db
      .select()
      .from(oauthPendings)
      .where(eq(oauthPendings.state, state))
      .limit(1);
    if (!row) return null;
    const owners: Array<{ kind: OwnerKind; id: string; ownerId: string }> = [];
    if (row.serviceCredentialId) {
      const [cred] = await db
        .select()
        .from(serviceCredentials)
        .where(eq(serviceCredentials.id, row.serviceCredentialId))
        .limit(1);
      if (cred)
        owners.push({
          kind: "service",
          id: cred.id,
          ownerId: cred.serviceId,
        });
    }
    if (row.moduleCredentialId) {
      const [cred] = await db
        .select()
        .from(moduleCredentials)
        .where(eq(moduleCredentials.id, row.moduleCredentialId))
        .limit(1);
      if (cred)
        owners.push({
          kind: "module",
          id: cred.id,
          ownerId: cred.moduleId,
        });
    }
    if (row.registryCredentialId) {
      const [cred] = await db
        .select()
        .from(registryCredentials)
        .where(eq(registryCredentials.id, row.registryCredentialId))
        .limit(1);
      if (cred)
        owners.push({
          kind: "registry",
          id: cred.id,
          ownerId: cred.registryId,
        });
    }
    if (owners.length !== 1) {
      logger.warn(
        {
          event: "oauth-pending-owner-invariant",
          state,
          owners: owners.length,
        },
        "Pending authorization does not resolve to exactly one credential",
      );
      return null;
    }
    const owner = owners[0];
    const store = this.storeFor(owner.kind, owner.ownerId);
    const credential = await store.getCredential(owner.id);
    if (!credential) return null;
    return {
      state: row.state,
      credential,
      codeVerifier: row.codeVerifier,
      redirectUri: row.redirectUri,
      requestedScopes: row.requestedScopes ?? [],
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }

  async listPendingsFor(
    kind: OwnerKind,
    credentialId: string,
  ): Promise<Array<{ state: string; createdAt: number; expiresAt: number }>> {
    const column =
      kind === "service"
        ? oauthPendings.serviceCredentialId
        : kind === "module"
          ? oauthPendings.moduleCredentialId
          : oauthPendings.registryCredentialId;
    return db
      .select({
        state: oauthPendings.state,
        createdAt: oauthPendings.createdAt,
        expiresAt: oauthPendings.expiresAt,
      })
      .from(oauthPendings)
      .where(eq(column, credentialId));
  }

  storeFor(kind: OwnerKind, ownerId: string): OwnerCredentialStore {
    if (kind === "service") return this.forService(ownerId);
    if (kind === "module") return this.forModule(ownerId);
    return this.forRegistry(ownerId);
  }

  async completeOAuthAuthorization(
    state: string,
    code: string,
  ): Promise<NormalizedCredential> {
    const pending = await this.getPending(state);
    if (!pending) {
      throw new HttpError(400, "Invalid or expired authorization state.");
    }
    if (pending.expiresAt < Date.now()) {
      await db.delete(oauthPendings).where(eq(oauthPendings.state, state));
      throw new HttpError(400, "Authorization code has expired.");
    }
    const { credential } = pending;
    if (!credential.oauthClientId) {
      throw new HttpError(404, "OAuth client not found for credential.");
    }
    const client = await this.getOAuthClientRow(credential.oauthClientId);
    if (!client) throw new HttpError(404, "OAuth client not found.");
    const decryptedClientSecret = decryptSecrets(client.clientSecret);
    const clientSecret = decryptedClientSecret.clientSecret as string;

    const tokenState = await exchangeAuthorizationCode({
      code,
      codeVerifier: pending.codeVerifier,
      tokenUrl: client.tokenUrl,
      clientId: client.clientId,
      clientSecret,
      clientAuthMethod: client.clientAuthMethod,
      redirectUri: pending.redirectUri,
      scopes: pending.requestedScopes,
    });
    const granted = parseGrantedScopes(
      tokenState.rawScope,
      pending.requestedScopes,
    );

    const encryptedToken = encryptSecrets({
      accessToken: tokenState.accessToken,
      refreshToken: tokenState.refreshToken,
      expiresAt: tokenState.expiresAt,
    });
    const store = this.storeFor(credential.kind, credential.ownerId);
    await this.persistTokens(
      credential.kind,
      credential.id,
      encryptedToken,
      granted.scopes,
      granted.source,
    );
    await db.delete(oauthPendings).where(eq(oauthPendings.state, state));
    await store.setStatus(credential.id, "active");

    logger.info(
      {
        event: "oauth-callback",
        credentialId: credential.id,
        status: "success",
      },
      "OAuth authorization completed",
    );
    const updated = await store.getCredential(credential.id);
    if (!updated) throw new HttpError(404, "Credential not found.");
    return updated;
  }

  private async persistTokens(
    kind: OwnerKind,
    credentialId: string,
    encrypted: EncryptedSecretsPayload,
    grantedScopes: string[],
    grantedSource: "provider" | "inferred",
  ): Promise<void> {
    const authUpdatedAt = Date.now();
    const rowUpdatedAt = new Date().toISOString();
    await db.transaction(async (tx) => {
      if (kind === "service") {
        await tx
          .update(serviceCredentialAuth)
          .set({ payload: encrypted, updatedAt: authUpdatedAt })
          .where(eq(serviceCredentialAuth.credentialId, credentialId));
        await tx
          .update(serviceCredentials)
          .set({
            grantedScopes,
            grantedSource,
            updatedAt: rowUpdatedAt,
          })
          .where(eq(serviceCredentials.id, credentialId));
      } else if (kind === "module") {
        await tx
          .update(moduleCredentialAuth)
          .set({ payload: encrypted, updatedAt: authUpdatedAt })
          .where(eq(moduleCredentialAuth.credentialId, credentialId));
        await tx
          .update(moduleCredentials)
          .set({
            grantedScopes,
            grantedSource,
            updatedAt: rowUpdatedAt,
          })
          .where(eq(moduleCredentials.id, credentialId));
      } else {
        await tx
          .update(registryCredentialAuth)
          .set({ payload: encrypted, updatedAt: authUpdatedAt })
          .where(eq(registryCredentialAuth.credentialId, credentialId));
        await tx
          .update(registryCredentials)
          .set({
            grantedScopes,
            grantedSource,
            updatedAt: rowUpdatedAt,
          })
          .where(eq(registryCredentials.id, credentialId));
      }
    });
  }

  async executeRefresh(
    kind: OwnerKind,
    ownerId: string,
    credentialId: string,
    refreshType: TokenRefreshType,
  ): Promise<OAuthTokenState> {
    const store = this.storeFor(kind, ownerId);
    const credential = await store.getCredential(credentialId);
    if (!credential?.oauthClientId) {
      throw new HttpError(
        404,
        `OAuth client for credential '${credentialId}' not found.`,
      );
    }
    const client = await this.getOAuthClientRow(credential.oauthClientId);
    if (!client) {
      throw new HttpError(
        404,
        `OAuth client for credential '${credentialId}' not found.`,
      );
    }
    const decrypted = await store.getDecryptedAuth(credentialId);
    const existingToken =
      decrypted?.accessToken != null
        ? {
            accessToken: decrypted.accessToken as string,
            refreshToken: decrypted.refreshToken as string | undefined,
            expiresAt: decrypted.expiresAt as number,
          }
        : undefined;
    if (!existingToken?.refreshToken) {
      throw new HttpError(
        409,
        `Credential '${credentialId}' has no refresh token. Re-authorize the credential.`,
      );
    }
    const clientSecret = decryptSecrets(client.clientSecret)
      .clientSecret as string;
    const tokenState = await doTokenExchange(
      {
        credentialId,
        clientId: client.clientId,
        clientSecret,
        tokenUrl: client.tokenUrl,
        scopes: credential.requestedScopes,
        refreshToken: existingToken.refreshToken,
        fallbackExpiresAt: existingToken.expiresAt,
        kind,
      },
      refreshType,
    );
    const granted = parseGrantedScopes(
      tokenState.rawScope,
      credential.requestedScopes,
    );
    const encrypted = encryptSecrets({
      accessToken: tokenState.accessToken,
      refreshToken: tokenState.refreshToken,
      expiresAt: tokenState.expiresAt,
    });
    await this.persistTokens(
      kind,
      credentialId,
      encrypted,
      granted.scopes,
      granted.source,
    );
    logger.info(
      {
        event: "token-refreshed",
        credentialId,
        expiresAt: tokenState.expiresAt,
        refreshType,
      },
      "Refreshed OAuth2 token",
    );
    return {
      accessToken: tokenState.accessToken,
      refreshToken: tokenState.refreshToken,
      expiresAt: tokenState.expiresAt,
    };
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

async function exchangeAuthorizationCode(params: {
  code: string;
  codeVerifier: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  clientAuthMethod: string;
  redirectUri: string;
  scopes: string[] | null;
}): Promise<OAuthTokenState & { rawScope: Record<string, unknown> }> {
  const {
    code,
    codeVerifier,
    tokenUrl,
    clientId,
    clientSecret,
    clientAuthMethod,
    redirectUri,
    scopes,
  } = params;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (clientAuthMethod === "client_secret_post") {
    body.set("client_secret", clientSecret);
  } else {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  }
  if (scopes && scopes.length > 0) {
    body.set("scope", scopes.join(" "));
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    TOKEN_ENDPOINT_TIMEOUT_MS,
  );

  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers,
      body: body.toString(),
      signal: controller.signal,
      redirect: "manual",
    });
  } catch {
    clearTimeout(timeout);
    throw new HttpError(502, "OAuth2 token endpoint is unreachable.");
  }
  clearTimeout(timeout);

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new HttpError(
      502,
      "OAuth2 token endpoint redirected the token request; refusing to follow redirects with credentials in the body.",
    );
  }

  if (!response.ok) {
    throw new HttpError(
      502,
      `OAuth2 token endpoint responded with status ${response.status}.`,
    );
  }

  const respBody = (await response.json()) as Record<string, unknown>;
  const accessToken = respBody.access_token as string;
  if (!accessToken) {
    throw new HttpError(
      502,
      "OAuth2 token endpoint response was missing an access token.",
    );
  }

  const expiresIn = respBody.expires_in as number | undefined;
  return {
    accessToken,
    refreshToken: respBody.refresh_token as string | undefined,
    expiresAt:
      Date.now() + (typeof expiresIn === "number" ? expiresIn : 3600) * 1000,
    rawScope: respBody,
  };
}

async function doTokenExchange(
  entry: {
    credentialId: string;
    clientId: string;
    clientSecret: string;
    tokenUrl: string;
    scopes: string[];
    refreshToken: string;
    fallbackExpiresAt: number;
    kind: OwnerKind;
  },
  refreshType: TokenRefreshType,
): Promise<OAuthTokenState & { rawScope: Record<string, unknown> }> {
  const {
    credentialId,
    clientId,
    clientSecret,
    tokenUrl,
    scopes,
    refreshToken: currentRefreshToken,
    fallbackExpiresAt,
    kind,
  } = entry;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: currentRefreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (scopes && scopes.length > 0) {
    body.set("scope", scopes.join(" "));
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    TOKEN_ENDPOINT_TIMEOUT_MS,
  );

  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (err) {
    clearTimeout(timeout);
    logger.warn(
      { event: "auth-refresh-failed", credentialId, err },
      "OAuth2 token endpoint is unreachable",
    );
    throw new HttpError(502, "OAuth2 token endpoint is unreachable.");
  }
  clearTimeout(timeout);

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    logger.warn(
      { event: "auth-refresh-failed", credentialId },
      "OAuth2 token endpoint redirected the refresh request",
    );
    throw new HttpError(
      502,
      "OAuth2 token endpoint redirected the token request; refusing to follow redirects with credentials in the body.",
    );
  }

  if (!response.ok) {
    const errorCode = await readOAuthErrorCode(response);
    const revoked = errorCode === "invalid_grant";
    const now = new Date().toISOString();
    const failedStatus = revoked ? "revoked" : "error";
    const targetTable =
      kind === "service"
        ? serviceCredentials
        : kind === "module"
          ? moduleCredentials
          : registryCredentials;
    await db
      .update(targetTable)
      .set({ status: failedStatus, updatedAt: now })
      .where(eq(targetTable.id, credentialId))
      .catch(() => undefined);
    logger.warn(
      {
        event: "auth-failure",
        credentialId,
        schemeType: "oauth2",
        errorCode: errorCode ?? `http_${response.status}`,
      },
      revoked
        ? "OAuth2 grant was revoked by the provider"
        : "OAuth2 token refresh failed",
    );
    throw new HttpError(
      revoked ? 401 : 502,
      revoked
        ? `OAuth2 grant for credential '${credentialId}' was revoked. Re-authorize the credential.`
        : `OAuth2 token endpoint responded with status ${response.status}.`,
    );
  }

  const respBody = (await response.json()) as Record<string, unknown>;
  const accessToken = respBody.access_token as string;
  if (!accessToken) {
    throw new HttpError(
      502,
      "OAuth2 token endpoint response was missing an access token.",
    );
  }

  const expiresIn = respBody.expires_in as number | undefined;
  const newExpiresAt =
    typeof expiresIn === "number"
      ? Date.now() + expiresIn * 1000
      : Math.max(fallbackExpiresAt, Date.now() + 3600 * 1000);
  const refreshToken =
    (respBody.refresh_token as string) ?? currentRefreshToken;

  const tokenState: OAuthTokenState = {
    accessToken,
    refreshToken,
    expiresAt: newExpiresAt,
  };

  logger.info(
    {
      event: "token-refreshed",
      credentialId,
      expiresAt: newExpiresAt,
      refreshType,
    },
    "Refreshed OAuth2 token",
  );

  return { ...tokenState, rawScope: respBody };
}

async function readOAuthErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}
