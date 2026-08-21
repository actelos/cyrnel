import dns from "node:dns/promises";

import { eq } from "drizzle-orm";
import ipaddr from "ipaddr.js";
import { z } from "zod";

import { db } from "@/db/client";
import { registries, registryAuth } from "@/db/schema";
import { logger } from "@/infra/logging";
import { HttpError } from "@/models/error.model";
import {
  assertRegistryAddressAllowed,
  matchesCIDRs,
  type ParsedCIDR,
  parseCIDRList,
} from "@/utils/download.util";
import {
  decryptAndMaybeReEncrypt,
  type EncryptedSecretsPayload,
  encryptSecrets,
} from "@/utils/secrets.util";

const TOKEN_EXPIRY_SKEW_MS = 30_000;
const TOKEN_ENDPOINT_TIMEOUT_MS = 10_000;

const encryptedPayloadSchema = z.object({
  kid: z.string().optional(),
  alg: z.literal("aes-256-gcm"),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

const oauthTokenSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.number(),
});

interface OAuthTokenState {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

interface RegistryAuthEntry {
  registryId: string;
  baseUrl: string;
  authType: "apiKey" | "oauth2";
  apiKey?: string;
  headerName?: string;
  clientId?: string;
  clientSecret?: string;
  tokenEndpoint?: string;
  scopes?: string[];
  token?: OAuthTokenState;
  exchangePromise: Promise<OAuthTokenState> | null;
}

export interface ApiKeyAuthMaterial {
  type: "apiKey";
  apiKey: string;
  headerName: string;
}

export interface OAuthAuthMaterial {
  type: "oauth2";
  clientId: string;
  clientSecret: string;
  tokenEndpoint: string;
  scopes?: string[];
}

export type RegistryAuthMaterial = ApiKeyAuthMaterial | OAuthAuthMaterial;

export interface RegistryAuthHeaders {
  headers: Record<string, string>;
  authType: "apiKey" | "oauth2";
  registryId: string;
}

export interface AuthFetchResult {
  response: Response;
  auth: RegistryAuthHeaders | null;
}

function mergeHeaders(
  base: Record<string, string> | undefined,
  auth: RegistryAuthHeaders | null,
): Record<string, string> | undefined {
  if (!auth) return base;
  return { ...(base ?? {}), ...auth.headers };
}

/**
 * Issues one HTTP request with registry auth attached when the URL falls
 * within a configured registry's scope. On a 401 from an oauth2 registry the
 * cached access token is invalidated, a fresh token is exchanged, and the
 * request is retried exactly once. Redirects are surfaced to the caller
 * (`redirect: "manual"`) so per-hop re-validation and auth re-attachment
 * stay in the caller's loop.
 */
export async function fetchWithRegistryAuth(
  url: string,
  init: Omit<RequestInit, "headers"> & {
    headers?: Record<string, string>;
  } = {},
): Promise<AuthFetchResult> {
  const initial = await headersForUrl(url);
  let response = await fetch(url, {
    ...init,
    headers: mergeHeaders(init.headers, initial),
    redirect: "manual",
  });

  if (response.status === 401 && initial?.authType === "oauth2") {
    await response.body?.cancel().catch(() => {});
    await invalidateAccessToken(initial.registryId);
    const refreshed = await headersForUrl(url);
    if (refreshed) {
      response = await fetch(url, {
        ...init,
        headers: mergeHeaders(init.headers, refreshed),
        redirect: "manual",
      });
    }
  }

  return { response, auth: initial };
}

let authCache: Map<string, RegistryAuthEntry> | null = null;

let cachedInsecureCIDRs: { raw: string | undefined; cidrs: ParsedCIDR[] } = {
  raw: undefined,
  cidrs: [],
};

function getInsecureAuthCIDRs(): ParsedCIDR[] {
  const raw = process.env.CYRNEL_REGISTRY_AUTH_INSECURE_CIDRS;
  if (raw !== cachedInsecureCIDRs.raw) {
    cachedInsecureCIDRs = { raw, cidrs: parseCIDRList(raw) };
  }
  return cachedInsecureCIDRs.cidrs;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isAddressLoopback(address: string): boolean {
  const parsed = ipaddr.process(address);
  if (parsed.kind() === "ipv4") {
    return parsed.range() === "loopback";
  }
  if (parsed.range() === "ipv4Mapped") {
    return (parsed as ipaddr.IPv6).toIPv4Address().range() === "loopback";
  }
  return parsed.range() === "loopback";
}

async function resolveAddresses(hostname: string): Promise<string[] | null> {
  const normalizedHost =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  if (ipaddr.isValid(normalizedHost)) return [normalizedHost];

  try {
    const resolved = await dns.lookup(normalizedHost, { all: true });
    return resolved.map(({ address }) => address);
  } catch {
    return null;
  }
}

async function isResolvedLoopback(hostname: string): Promise<boolean> {
  const addresses = await resolveAddresses(hostname);
  if (addresses === null) return false;
  return addresses.some((address) => {
    if (!ipaddr.isValid(address)) return false;
    return isAddressLoopback(address);
  });
}

async function isResolvedInCIDRs(
  hostname: string,
  cidrs: ParsedCIDR[],
): Promise<boolean> {
  if (cidrs.length === 0) return false;
  const addresses = await resolveAddresses(hostname);
  if (addresses === null) return false;
  return addresses.some((address) => {
    if (!ipaddr.isValid(address)) return false;
    return matchesCIDRs(address, cidrs);
  });
}

export async function isCredentialTransportAllowed(
  url: string,
): Promise<boolean> {
  if (!isHttpUrl(url)) return false;
  const parsed = new URL(url);
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;

  if (await isResolvedLoopback(parsed.hostname)) return true;
  return isResolvedInCIDRs(parsed.hostname, getInsecureAuthCIDRs());
}

function isUrlInRegistryScope(urlString: string, baseUrl: string): boolean {
  let url: URL;
  let base: URL;
  try {
    url = new URL(urlString);
    base = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.origin !== base.origin) return false;
  if (base.pathname === "/") return true;
  const basePath = base.pathname.endsWith("/")
    ? base.pathname
    : `${base.pathname}/`;
  return url.pathname === base.pathname || url.pathname.startsWith(basePath);
}

async function persistToken(
  entry: RegistryAuthEntry,
  payload: OAuthTokenState,
): Promise<void> {
  await db
    .update(registryAuth)
    .set({
      token: encryptSecrets({
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        expiresAt: payload.expiresAt,
      }),
      tokenExpiresAt: payload.expiresAt,
      updatedAt: Date.now(),
    })
    .where(eq(registryAuth.registryId, entry.registryId))
    .catch(() => {
      logger.warn(
        {
          event: "registry-auth-token-persist-failed",
          registryId: entry.registryId,
        },
        "Failed to persist registry auth token",
      );
    });
}

async function loadAuthCache(): Promise<Map<string, RegistryAuthEntry>> {
  if (authCache) return authCache;

  const loaded = new Map<string, RegistryAuthEntry>();
  try {
    const rows = await db
      .select({
        registryId: registries.id,
        baseUrl: registries.baseUrl,
        authType: registryAuth.authType,
        config: registryAuth.config,
        token: registryAuth.token,
        tokenEndpoint: registryAuth.tokenEndpoint,
        headerName: registryAuth.headerName,
      })
      .from(registries)
      .leftJoin(registryAuth, eq(registryAuth.registryId, registries.id));

    for (const row of rows) {
      if (!row.authType || !row.config) continue;

      const entry: RegistryAuthEntry = {
        registryId: row.registryId,
        baseUrl: row.baseUrl,
        authType: row.authType,
        tokenEndpoint: row.tokenEndpoint ?? undefined,
        headerName: row.headerName ?? undefined,
        exchangePromise: null,
      };

      try {
        const config = await decryptAndMaybeReEncrypt(
          parseStoredPayload(row.config, "config"),
          async (reEncrypted) => {
            await db
              .update(registryAuth)
              .set({ config: reEncrypted, updatedAt: Date.now() })
              .where(eq(registryAuth.registryId, row.registryId));
          },
          {
            event: "registry-auth-config-reencrypted",
            registryId: row.registryId,
          },
        );

        if (entry.authType === "apiKey") {
          const apiKey = config.apiKey;
          if (typeof apiKey !== "string" || apiKey.length === 0) continue;
          entry.apiKey = apiKey;
        } else {
          const clientId = config.clientId;
          const clientSecret = config.clientSecret;
          if (
            typeof clientId !== "string" ||
            clientId.length === 0 ||
            typeof clientSecret !== "string" ||
            clientSecret.length === 0
          ) {
            continue;
          }
          entry.clientId = clientId;
          entry.clientSecret = clientSecret;
          if (Array.isArray(config.scopes)) {
            const scopes = config.scopes;
            if (scopes.every((scope) => typeof scope === "string")) {
              entry.scopes = scopes as string[];
            }
          }
        }

        if (entry.authType === "oauth2" && row.token) {
          const token = await decryptAndMaybeReEncrypt(
            parseStoredPayload(row.token, "token"),
            async (reEncrypted) => {
              await db
                .update(registryAuth)
                .set({ token: reEncrypted, updatedAt: Date.now() })
                .where(eq(registryAuth.registryId, row.registryId));
            },
            {
              event: "registry-auth-token-reencrypted",
              registryId: row.registryId,
            },
          );
          const parsed = oauthTokenSchema.safeParse(token);
          if (parsed.success) entry.token = parsed.data;
        }
      } catch (err) {
        logger.warn(
          {
            event: "registry-auth-entry-load-failed",
            registryId: row.registryId,
            err,
          },
          "Failed to load registry auth entry",
        );
        continue;
      }

      loaded.set(row.registryId, entry);
    }
  } catch (err) {
    logger.warn(
      { event: "registry-auth-cache-load-failed", err },
      "Failed to load registry auth cache",
    );
  }

  authCache = loaded;
  return authCache;
}

function parseStoredPayload(
  payload: unknown,
  label: string,
): EncryptedSecretsPayload {
  const parsed = encryptedPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new HttpError(
      500,
      `Stored registry auth '${label}' payload is malformed.`,
    );
  }
  return parsed.data;
}

export function invalidateRegistryAuthCache(): void {
  authCache = null;
}

export async function invalidateAccessToken(registryId: string): Promise<void> {
  const cache = await loadAuthCache();
  const entry = cache.get(registryId);
  if (entry && entry.authType === "oauth2") {
    entry.token = undefined;
    entry.exchangePromise = null;
  }
}

export async function getRegistryAuthEntry(
  registryId: string,
): Promise<RegistryAuthEntry | null> {
  const cache = await loadAuthCache();
  return cache.get(registryId) ?? null;
}

export async function getRegistryAuthExpiry(
  registryId: string,
): Promise<number | null> {
  const entry = await getRegistryAuthEntry(registryId);
  if (entry?.authType !== "oauth2" || !entry.token) return null;
  return entry.token.expiresAt;
}

export async function registryAuthForUrl(
  url: string,
): Promise<RegistryAuthEntry | null> {
  const cache = await loadAuthCache();
  for (const entry of cache.values()) {
    if (isUrlInRegistryScope(url, entry.baseUrl)) return entry;
  }
  return null;
}

export async function headersForUrl(
  url: string,
): Promise<RegistryAuthHeaders | null> {
  const entry = await registryAuthForUrl(url);
  if (!entry) return null;

  if (!(await isCredentialTransportAllowed(url))) {
    throw new HttpError(
      502,
      "Registry authentication requires https; refusing to send credentials over plaintext http.",
    );
  }

  if (entry.authType === "apiKey") {
    if (!entry.headerName || !entry.apiKey) return null;
    return {
      headers: { [entry.headerName]: entry.apiKey },
      authType: "apiKey",
      registryId: entry.registryId,
    };
  }

  const accessToken = await ensureAccessToken(entry);
  return {
    headers: { authorization: `Bearer ${accessToken}` },
    authType: "oauth2",
    registryId: entry.registryId,
  };
}

async function ensureAccessToken(entry: RegistryAuthEntry): Promise<string> {
  if (
    entry.token &&
    entry.token.expiresAt > Date.now() + TOKEN_EXPIRY_SKEW_MS
  ) {
    return entry.token.accessToken;
  }

  if (!entry.exchangePromise) {
    entry.exchangePromise = doTokenExchange(entry).finally(() => {
      entry.exchangePromise = null;
    });
  }

  return (await entry.exchangePromise).accessToken;
}

async function doTokenExchange(
  entry: RegistryAuthEntry,
): Promise<OAuthTokenState> {
  const tokenEndpoint = entry.tokenEndpoint;
  const clientId = entry.clientId;
  const clientSecret = entry.clientSecret;

  if (!tokenEndpoint || !clientId || !clientSecret) {
    throw new HttpError(502, "Registry oauth2 configuration is incomplete.");
  }

  if (!(await isCredentialTransportAllowed(tokenEndpoint))) {
    throw new HttpError(
      400,
      "Registry oauth2 token endpoint must be https; refusing to send client credentials over plaintext http.",
    );
  }

  await assertRegistryAddressAllowed(tokenEndpoint);

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (entry.scopes && entry.scopes.length > 0) {
    body.set("scope", entry.scopes.join(" "));
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    TOKEN_ENDPOINT_TIMEOUT_MS,
  );

  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    throw new HttpError(502, "Registry oauth2 token endpoint is unreachable.");
  }
  clearTimeout(timeout);

  const tokenState = await parseTokenResponse(response, entry.registryId);
  await persistToken(entry, tokenState);
  entry.token = tokenState;
  logger.debug(
    { event: "registry-auth-token-exchanged", registryId: entry.registryId },
    "Exchanged registry oauth2 client credentials",
  );
  return tokenState;
}

async function parseTokenResponse(
  response: Response,
  registryId: string,
): Promise<OAuthTokenState> {
  if (!response.ok) {
    throw new HttpError(
      502,
      `Registry oauth2 token endpoint responded with status ${response.status}.`,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new HttpError(
      502,
      "Registry oauth2 token endpoint returned invalid JSON.",
    );
  }

  const accessToken = body.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    logger.warn(
      { event: "registry-auth-token-response-invalid", registryId },
      "Registry oauth2 token endpoint response was missing an access token",
    );
    throw new HttpError(
      502,
      "Registry oauth2 token endpoint response was missing an access token.",
    );
  }

  let expiresAt = Date.now() + 3_600_000;
  if (typeof body.expires_in === "number" && Number.isFinite(body.expires_in)) {
    expiresAt = Date.now() + body.expires_in * 1000;
  }

  const refreshToken =
    typeof body.refresh_token === "string" && body.refresh_token.length > 0
      ? body.refresh_token
      : undefined;

  return { accessToken, refreshToken, expiresAt };
}

export async function exchangeClientCredentials(
  material: OAuthAuthMaterial,
): Promise<OAuthTokenState> {
  if (!(await isCredentialTransportAllowed(material.tokenEndpoint))) {
    throw new HttpError(
      400,
      "Registry oauth2 token endpoint must be https; refusing to send client credentials over plaintext http.",
    );
  }

  await assertRegistryAddressAllowed(material.tokenEndpoint);

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: material.clientId,
    client_secret: material.clientSecret,
  });
  if (material.scopes && material.scopes.length > 0) {
    body.set("scope", material.scopes.join(" "));
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    TOKEN_ENDPOINT_TIMEOUT_MS,
  );

  let response: Response;
  try {
    response = await fetch(material.tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    throw new HttpError(502, "Registry oauth2 token endpoint is unreachable.");
  }
  clearTimeout(timeout);

  return parseTokenResponse(response, "(new registry)");
}
