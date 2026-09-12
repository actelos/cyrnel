import dns from "node:dns/promises";

import { eq } from "drizzle-orm";
import ipaddr from "ipaddr.js";
import { z } from "zod";

import { db } from "@/db/client";
import {
  registries,
  registryCredentialAuth,
  registryCredentials,
} from "@/db/schema";
import { logger } from "@/infra/logging";
import { HttpError } from "@/models/error.model";
import {
  assertRegistryAddressAllowed,
  matchesCIDRs,
  type ParsedCIDR,
  parseCIDRList,
} from "@/utils/download.util";
import type { RegistryIndexInfo } from "@/utils/registry.util";
import {
  decryptAndMaybeReEncrypt,
  type EncryptedSecretsPayload,
  encryptSecrets,
} from "@/utils/secrets.util";
import { dispatcherForUrl } from "@/utils/secure-dispatcher";

const TOKEN_EXPIRY_SKEW_MS = 30_000;
const TOKEN_ENDPOINT_TIMEOUT_MS = 10_000;

const encryptedPayloadSchema = z.object({
  kid: z.string().optional(),
  alg: z.literal("aes-256-gcm"),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

interface CachedClientCredentialsToken {
  accessToken: string;
  expiresAt: number;
}

type SchemeMaterial =
  | {
      kind: "apiKey";
      credentialId: string;
      paramName: string;
      prefix?: string;
      value: string;
    }
  | {
      kind: "basic";
      credentialId: string;
      username: string;
      password: string;
    }
  | {
      kind: "bearer";
      credentialId: string;
      token: string;
    }
  | {
      kind: "oauth2-cc";
      credentialId: string;
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      requestedScopes: string[];
      accessToken?: string;
      expiresAt?: number;
      exchangePromise: Promise<CachedClientCredentialsToken> | null;
    }
  | {
      kind: "oauth2-ac";
      credentialId: string;
      schemeName: string;
    };

interface RegistryMaterialEntry {
  registryId: string;
  baseUrl: string;
  schemes: Map<string, SchemeMaterial>;
}

export interface RegistryAuthHeaders {
  headers: Record<string, string>;
  schemes: string[];
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

export async function fetchWithRegistryAuth(
  url: string,
  init: Omit<RequestInit, "headers"> & {
    headers?: Record<string, string>;
  } = {},
  opts: { skipAuth?: boolean } = {},
): Promise<AuthFetchResult> {
  const initial = opts.skipAuth ? null : await headersForUrl(url);
  let response = await fetch(url, {
    ...init,
    headers: mergeHeaders(init.headers, initial),
    redirect: "manual",
    dispatcher: dispatcherForUrl(url),
  });

  if (response.status === 401 && initial && !opts.skipAuth) {
    await response.body?.cancel().catch(() => {});
    await invalidateAccessTokens(initial.registryId);
    const refreshed = await headersForUrl(url);
    if (refreshed) {
      response = await fetch(url, {
        ...init,
        headers: mergeHeaders(init.headers, refreshed),
        redirect: "manual",
        dispatcher: dispatcherForUrl(url),
      });
      return { response, auth: refreshed };
    }
  }

  return { response, auth: initial };
}

let materialCache: Map<string, RegistryMaterialEntry> | null = null;
let registryListCache: Array<{ id: string; baseUrl: string }> | null = null;

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
  materialCache = null;
  registryListCache = null;
}

export async function invalidateAccessToken(registryId: string): Promise<void> {
  await invalidateAccessTokens(registryId);
}

async function invalidateAccessTokens(registryId: string): Promise<void> {
  const entry = materialCache?.get(registryId);
  if (!entry) return;
  for (const material of entry.schemes.values()) {
    if (material.kind === "oauth2-cc") {
      material.accessToken = undefined;
      material.expiresAt = undefined;
      material.exchangePromise = null;
    }
  }
}

async function loadRegistryList(): Promise<
  Array<{ id: string; baseUrl: string }>
> {
  if (registryListCache) return registryListCache;
  try {
    const rows = await db
      .select({ id: registries.id, baseUrl: registries.baseUrl })
      .from(registries);
    registryListCache = rows;
    return rows;
  } catch {
    return [];
  }
}

async function registryForUrl(
  url: string,
): Promise<{ id: string; baseUrl: string } | null> {
  for (const registry of await loadRegistryList()) {
    if (isUrlInRegistryScope(url, registry.baseUrl)) return registry;
  }
  return null;
}

async function loadMaterials(
  registryId: string,
  baseUrl: string,
): Promise<RegistryMaterialEntry> {
  if (materialCache?.has(registryId)) {
    return materialCache.get(registryId) as RegistryMaterialEntry;
  }
  const entry: RegistryMaterialEntry = {
    registryId,
    baseUrl,
    schemes: new Map(),
  };
  try {
    const rows = await db
      .select({
        id: registryCredentials.id,
        schemeName: registryCredentials.schemeName,
        schemeType: registryCredentials.schemeType,
        status: registryCredentials.status,
        requestedScopes: registryCredentials.requestedScopes,
        grantedScopes: registryCredentials.grantedScopes,
        payload: registryCredentialAuth.payload,
      })
      .from(registryCredentials)
      .leftJoin(
        registryCredentialAuth,
        eq(registryCredentialAuth.credentialId, registryCredentials.id),
      )
      .where(eq(registryCredentials.registryId, registryId));
    for (const row of rows) {
      if (row.status !== "active" || !row.payload) continue;
      let secrets: Record<string, unknown>;
      try {
        secrets = await decryptAndMaybeReEncrypt(
          parseStoredPayload(row.payload, "secret"),
          async (reEncrypted) => {
            await db
              .update(registryCredentialAuth)
              .set({ payload: reEncrypted, updatedAt: Date.now() })
              .where(eq(registryCredentialAuth.credentialId, row.id));
          },
          {
            event: "registry-auth-secret-reencrypted",
            registryId,
          },
        );
      } catch (err) {
        logger.warn(
          { event: "registry-auth-entry-load-failed", registryId, err },
          "Failed to load registry credential",
        );
        continue;
      }
      const material = toMaterial(
        row.id,
        row.schemeName,
        row.schemeType,
        row.requestedScopes ?? [],
        secrets,
      );
      if (material) entry.schemes.set(row.schemeName, material);
    }
  } catch (err) {
    logger.warn(
      { event: "registry-auth-cache-load-failed", registryId, err },
      "Failed to load registry credentials",
    );
    return entry;
  }
  if (!materialCache) materialCache = new Map();
  materialCache.set(registryId, entry);
  return entry;
}

function toMaterial(
  credentialId: string,
  schemeName: string,
  schemeType: string,
  requestedScopes: string[],
  secrets: Record<string, unknown>,
): SchemeMaterial | null {
  if (schemeType === "apiKey" && typeof secrets.apiKey === "string") {
    return {
      kind: "apiKey",
      credentialId,
      paramName: "",
      value: secrets.apiKey,
    };
  }
  if (
    schemeType === "basic" &&
    typeof secrets.username === "string" &&
    typeof secrets.password === "string"
  ) {
    return {
      kind: "basic",
      credentialId,
      username: secrets.username,
      password: secrets.password,
    };
  }
  if (schemeType === "bearer" && typeof secrets.token === "string") {
    return { kind: "bearer", credentialId, token: secrets.token };
  }
  if (schemeType === "oauth2") {
    if (
      typeof secrets.clientId === "string" &&
      typeof secrets.clientSecret === "string"
    ) {
      return {
        kind: "oauth2-cc",
        credentialId,
        tokenUrl: "",
        clientId: secrets.clientId,
        clientSecret: secrets.clientSecret,
        requestedScopes,
        accessToken:
          typeof secrets.accessToken === "string"
            ? secrets.accessToken
            : undefined,
        expiresAt:
          typeof secrets.expiresAt === "number" ? secrets.expiresAt : undefined,
        exchangePromise: null,
      };
    }
    if (typeof secrets.accessToken === "string") {
      return { kind: "oauth2-ac", credentialId, schemeName };
    }
  }
  logger.warn(
    { event: "registry-auth-entry-incomplete", credentialId, schemeName },
    "Registry credential has incomplete material; skipping",
  );
  return null;
}

async function accessTokenForCc(
  material: Extract<SchemeMaterial, { kind: "oauth2-cc" }>,
  registryId: string,
): Promise<string> {
  if (
    material.accessToken &&
    material.expiresAt !== undefined &&
    material.expiresAt > Date.now() + TOKEN_EXPIRY_SKEW_MS
  ) {
    return material.accessToken;
  }
  if (!material.exchangePromise) {
    material.exchangePromise = exchangeCcToken(material, registryId).finally(
      () => {
        material.exchangePromise = null;
      },
    );
  }
  return (await material.exchangePromise).accessToken;
}

async function exchangeCcToken(
  material: Extract<SchemeMaterial, { kind: "oauth2-cc" }>,
  registryId: string,
): Promise<ClientCredentialsToken> {
  const state = await exchangeClientCredentials({
    tokenEndpoint: material.tokenUrl,
    clientId: material.clientId,
    clientSecret: material.clientSecret,
    scopes: material.requestedScopes,
  });
  material.accessToken = state.accessToken;
  material.expiresAt = state.expiresAt;
  const existing = await readRawSecrets(material.credentialId);
  await db
    .update(registryCredentialAuth)
    .set({
      payload: encryptSecrets({
        ...existing,
        accessToken: state.accessToken,
        expiresAt: state.expiresAt,
      }),
      updatedAt: Date.now(),
    })
    .where(eq(registryCredentialAuth.credentialId, material.credentialId))
    .catch(() => {
      logger.warn(
        { event: "registry-auth-token-persist-failed", registryId },
        "Failed to persist registry auth token",
      );
    });
  logger.debug(
    { event: "registry-auth-token-exchanged", registryId },
    "Exchanged registry oauth2 client credentials",
  );
  return { accessToken: state.accessToken, expiresAt: state.expiresAt };
}

async function readRawSecrets(
  credentialId: string,
): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ payload: registryCredentialAuth.payload })
    .from(registryCredentialAuth)
    .where(eq(registryCredentialAuth.credentialId, credentialId))
    .limit(1)
    .catch(() => []);
  if (!row) return {};
  try {
    return (await decryptAndMaybeReEncrypt(
      parseStoredPayload(row.payload, "secret"),
      async () => {},
      { event: "registry-auth-secret-reread", credentialId },
    )) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function accessTokenForAc(
  registryId: string,
  schemeName: string,
): Promise<string> {
  const { RegistryCredentialProvider } = await import(
    "@/services/credential.provider"
  );
  const { CredentialService } = await import("@/services/credential.service");
  const provider = new RegistryCredentialProvider(
    registryId,
    new CredentialService(),
  );
  const credential = await provider.getCredential(schemeName);
  if (credential.type !== "oauth2") {
    throw new HttpError(
      500,
      `Registry credential for scheme '${schemeName}' resolved to '${credential.type}', expected an OAuth2 token.`,
    );
  }
  return credential.accessToken;
}

export async function headersForUrl(
  url: string,
): Promise<RegistryAuthHeaders | null> {
  const registry = await registryForUrl(url);
  if (!registry) return null;

  let index: RegistryIndexInfo | null = null;
  try {
    const { fetchCachedRegistryIndex } = await import("@/utils/registry.util");
    index = await fetchCachedRegistryIndex(registry.baseUrl);
  } catch (err) {
    logger.warn(
      { event: "registry-index-unavailable", registryId: registry.id, err },
      "Registry well-known unavailable; falling back to declaration-less auth",
    );
  }

  const { effectiveSecurityForUrl } = await import("@/utils/registry.util");
  const security = index ? effectiveSecurityForUrl(index, url) : [];
  if (security.length === 0 && index) return null;

  const entry = await loadMaterials(registry.id, registry.baseUrl);
  const schemes = index?.auth?.schemes;

  async function assertCredentialTransportAllowed(): Promise<void> {
    if (!(await isCredentialTransportAllowed(url))) {
      throw new HttpError(
        502,
        "Registry authentication requires https; refusing to send credentials over plaintext http.",
      );
    }
  }

  if (!index || !schemes) {
    const hasAttachable = [...entry.schemes.values()].some(
      (material) => material.kind !== "apiKey",
    );
    if (!hasAttachable) return null;
    await assertCredentialTransportAllowed();
    for (const [schemeName, material] of entry.schemes) {
      if (material.kind === "apiKey") continue;
      const headers = await materialize(
        material,
        schemeName,
        registry.id,
        undefined,
      );
      if (headers)
        return { headers, schemes: [schemeName], registryId: registry.id };
    }
    return null;
  }

  let lastError: string | null = null;
  for (const group of security) {
    const missing = Object.keys(group).find(
      (schemeName) => !schemes[schemeName] || !entry.schemes.get(schemeName),
    );
    if (missing) {
      lastError = `no credential configured for scheme '${missing}'`;
      continue;
    }
    await assertCredentialTransportAllowed();
    const headers: Record<string, string> = {};
    const used: string[] = [];
    let satisfiable = true;
    for (const [schemeName, required] of Object.entries(group)) {
      const declared = schemes[schemeName];
      const material = entry.schemes.get(schemeName);
      if (!declared || !material) {
        satisfiable = false;
        lastError = `no credential configured for scheme '${schemeName}'`;
        break;
      }
      try {
        const placed = await materialize(material, schemeName, registry.id, {
          declared,
          required,
        });
        if (!placed) {
          satisfiable = false;
          lastError = `scheme '${schemeName}' could not satisfy the requirement`;
          break;
        }
        Object.assign(headers, placed);
        used.push(schemeName);
      } catch (err) {
        satisfiable = false;
        lastError = err instanceof Error ? err.message : String(err);
        break;
      }
    }
    if (satisfiable) {
      return { headers, schemes: used, registryId: registry.id };
    }
  }

  throw new HttpError(
    401,
    `Registry '${registry.id}' requires authentication for this route but no configured credential satisfies it${lastError ? `: ${lastError}` : "."} Configure credentials for the registry's schemes.`,
  );
}

async function materialize(
  material: SchemeMaterial,
  schemeName: string,
  registryId: string,
  requirement:
    | { declared: { type?: string }; required: readonly string[] }
    | undefined,
): Promise<Record<string, string> | null> {
  if (material.kind === "apiKey") {
    const paramName =
      requirement?.declared && "paramName" in requirement.declared
        ? (requirement.declared as { paramName: string }).paramName
        : material.paramName;
    if (!paramName) return null;
    const prefix =
      requirement?.declared && "prefix" in requirement.declared
        ? (requirement.declared as { prefix?: string }).prefix
        : undefined;
    const value =
      prefix !== undefined && prefix.length > 0
        ? `${prefix} ${material.value}`
        : material.value;
    return { [paramName]: value };
  }
  if (material.kind === "basic") {
    return {
      authorization: `Basic ${Buffer.from(`${material.username}:${material.password}`).toString("base64")}`,
    };
  }
  if (material.kind === "bearer") {
    return { authorization: `Bearer ${material.token}` };
  }
  if (material.kind === "oauth2-ac") {
    if (requirement && requirement.required.length > 0) {
      const { CredentialService } = await import(
        "@/services/credential.service"
      );
      const store = new CredentialService().forRegistry(registryId);
      const cred = await store.getForScheme(schemeName);
      const granted = new Set(cred?.grantedScopes ?? []);
      const missing = requirement.required.filter((s) => !granted.has(s));
      if (missing.length > 0) {
        throw new HttpError(
          401,
          `Registry credential for scheme '${schemeName}' lacks required scopes: ${missing.join(", ")}.`,
        );
      }
    }
    const accessToken = await accessTokenForAc(registryId, schemeName);
    return { authorization: `Bearer ${accessToken}` };
  }
  if (!requirement || !("tokenUrl" in (requirement.declared as object))) {
    return null;
  }
  material.tokenUrl = (requirement.declared as { tokenUrl: string }).tokenUrl;
  const accessToken = await accessTokenForCc(material, registryId);
  return { authorization: `Bearer ${accessToken}` };
}

export async function getRegistryAuthExpiry(
  registryId: string,
): Promise<number | null> {
  const entry = materialCache?.get(registryId);
  if (!entry) return null;
  let latest: number | null = null;
  for (const material of entry.schemes.values()) {
    if (material.kind === "oauth2-cc" && material.expiresAt !== undefined) {
      latest =
        latest === null
          ? material.expiresAt
          : Math.max(latest, material.expiresAt);
    }
  }
  return latest;
}

export interface ClientCredentialsMaterial {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
}

export interface ClientCredentialsToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export async function exchangeClientCredentials(
  material: ClientCredentialsMaterial,
): Promise<ClientCredentialsToken> {
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
      redirect: "manual",
      dispatcher: dispatcherForUrl(material.tokenEndpoint),
    });
  } catch {
    clearTimeout(timeout);
    throw new HttpError(502, "Registry oauth2 token endpoint is unreachable.");
  }
  clearTimeout(timeout);

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new HttpError(
      502,
      "Registry oauth2 token endpoint redirected the token request; refusing to follow redirects with credentials in the body.",
    );
  }

  if (!response.ok) {
    throw new HttpError(
      502,
      `Registry oauth2 token endpoint responded with status ${response.status}.`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new HttpError(
      502,
      "Registry oauth2 token endpoint returned invalid JSON.",
    );
  }

  const accessToken = parsed.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new HttpError(
      502,
      "Registry oauth2 token endpoint response was missing an access token.",
    );
  }

  let expiresAt = Date.now() + 3_600_000;
  if (
    typeof parsed.expires_in === "number" &&
    Number.isFinite(parsed.expires_in)
  ) {
    expiresAt = Date.now() + parsed.expires_in * 1000;
  }
  const refreshToken =
    typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0
      ? parsed.refresh_token
      : undefined;
  return { accessToken, refreshToken, expiresAt };
}
