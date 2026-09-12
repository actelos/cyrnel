import type {
  AuthScheme,
  OAuth2AuthScheme,
  SecurityRequirement,
  SecurityRequirements,
} from "@cyrnel/sdk";
import { maxSatisfying, valid } from "semver";
import { HttpError } from "@/models/error.model";
import { assertKind } from "@/utils/compatibility.util";
import { assertRegistryAddressAllowed } from "@/utils/download.util";
import { fetchWithRegistryAuth } from "@/utils/registry-auth.util";

const REGISTRY_FETCH_TIMEOUT_MS = 10_000;

export interface RegistryVersionEntry {
  downloadUrl: string;
  hash?: string;
  id?: string;
  kind?: string;
  icon?: RegistryIcon;
  engines?: {
    cyrnel?: string;
  };
}

export interface RegistryIcon {
  url: string;
  hash: string;
}

export interface VersionedRegistryDescriptor {
  latestVersion: string;
  versions: Record<string, RegistryVersionEntry>;
}

export interface ModuleRegistryResponse {
  version: string;
  downloadUrl: string;
  hash?: string;
  icon?: RegistryIcon;
  engines?: {
    cyrnel?: string;
  };
}

export interface ServiceRegistryResponse {
  version: string;
  downloadUrl: string;
  hash?: string;
  id?: string;
  kind?: string;
  icon?: RegistryIcon;
}

async function fetchRegistryJson(
  source: string,
  label: string,
): Promise<Record<string, unknown>> {
  const { body } = await fetchRegistryJsonSafe(source, label);
  return body;
}

function assertNonEmptyString(
  value: unknown,
  message: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, message);
  }
}

function normalizeOptionalString(
  value: unknown,
  message: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  assertNonEmptyString(value, message);
  return value.trim();
}

function validateVersionEntry(
  label: string,
  version: string,
  value: unknown,
): RegistryVersionEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(
      400,
      `${label} registry version '${version}' must be an object.`,
    );
  }

  const entry = value as Record<string, unknown>;
  assertNonEmptyString(
    entry.downloadUrl,
    `${label} registry version '${version}' must include a non-empty 'downloadUrl' string.`,
  );

  const engines = entry.engines;
  if (
    engines !== undefined &&
    (typeof engines !== "object" || engines === null || Array.isArray(engines))
  ) {
    throw new HttpError(
      400,
      `${label} registry version '${version}' 'engines' must be an object if provided.`,
    );
  }

  const cyrnel = (engines as Record<string, unknown> | undefined)?.cyrnel;
  if (cyrnel !== undefined && typeof cyrnel !== "string") {
    throw new HttpError(
      400,
      `${label} registry version '${version}' 'engines.cyrnel' must be a string if provided.`,
    );
  }

  const icon = entry.icon;
  if (
    icon !== undefined &&
    (typeof icon !== "object" || icon === null || Array.isArray(icon))
  ) {
    throw new HttpError(
      400,
      `${label} registry version '${version}' 'icon' must be an object if provided.`,
    );
  }
  const iconUrl = normalizeOptionalString(
    (icon as Record<string, unknown> | undefined)?.url,
    `${label} registry version '${version}' 'icon.url' must be a non-empty string if provided.`,
  );
  const iconHash = normalizeOptionalString(
    (icon as Record<string, unknown> | undefined)?.hash,
    `${label} registry version '${version}' 'icon.hash' must be a non-empty string if provided.`,
  );
  if (icon !== undefined && (iconUrl === undefined || iconHash === undefined)) {
    throw new HttpError(
      400,
      `${label} registry version '${version}' 'icon' must include non-empty 'url' and 'hash' strings.`,
    );
  }

  const kind = normalizeOptionalString(
    entry.kind,
    `${label} registry version '${version}' 'kind' must be a non-empty string if provided.`,
  );
  if (kind !== undefined) {
    assertKind(
      kind,
      `${label} registry version '${version}' 'kind' must match <identifier>@<version>, e.g. 'openapi@3.0'.`,
    );
  }

  return {
    downloadUrl: entry.downloadUrl.trim(),
    hash: normalizeOptionalString(
      entry.hash,
      `${label} registry version '${version}' 'hash' must be a non-empty string if provided.`,
    ),
    id: normalizeOptionalString(
      entry.id,
      `${label} registry version '${version}' 'id' must be a non-empty string if provided.`,
    ),
    kind,
    icon:
      iconUrl === undefined || iconHash === undefined
        ? undefined
        : { url: iconUrl, hash: iconHash },
    engines: cyrnel === undefined ? undefined : { cyrnel: cyrnel.trim() },
  };
}

function validateRegistryDescriptor(
  body: Record<string, unknown>,
  label: string,
): VersionedRegistryDescriptor {
  assertNonEmptyString(
    body.latestVersion,
    `${label} registry response must include a non-empty 'latestVersion' string.`,
  );
  if (valid(body.latestVersion.trim()) === null) {
    throw new HttpError(
      400,
      `${label} registry response 'latestVersion' must be a valid semver version.`,
    );
  }

  const versions = body.versions;
  if (
    typeof versions !== "object" ||
    versions === null ||
    Array.isArray(versions)
  ) {
    throw new HttpError(
      400,
      `${label} registry response must include a 'versions' object.`,
    );
  }

  const normalizedVersions: Record<string, RegistryVersionEntry> = {};
  for (const [version, entry] of Object.entries(versions)) {
    if (valid(version) === null) {
      throw new HttpError(
        400,
        `${label} registry version key '${version}' must be valid semver.`,
      );
    }
    normalizedVersions[version] = validateVersionEntry(label, version, entry);
  }

  const latestVersion = body.latestVersion.trim();
  if (normalizedVersions[latestVersion] === undefined) {
    throw new HttpError(
      400,
      `${label} registry response 'latestVersion' must reference a key in 'versions'.`,
    );
  }

  return { latestVersion, versions: normalizedVersions };
}

function resolveRegistryVersion(
  descriptor: VersionedRegistryDescriptor,
  label: string,
  constraint?: string,
): { version: string; entry: RegistryVersionEntry } {
  if (
    constraint === undefined ||
    constraint.trim() === "" ||
    constraint === "latest"
  ) {
    const entry = descriptor.versions[descriptor.latestVersion];
    return { version: descriptor.latestVersion, entry };
  }

  const version = maxSatisfying(
    Object.keys(descriptor.versions),
    constraint.trim(),
  );
  if (version === null) {
    throw new HttpError(
      404,
      `${label} registry has no version satisfying '${constraint}'.`,
    );
  }

  return { version, entry: descriptor.versions[version] };
}

export async function resolveModuleRegistry(
  source: string,
  constraint?: string,
): Promise<ModuleRegistryResponse> {
  const body = await fetchRegistryJson(source, "Module");
  const descriptor = validateRegistryDescriptor(body, "Module");
  const { version, entry } = resolveRegistryVersion(
    descriptor,
    "Module",
    constraint,
  );
  return {
    version,
    downloadUrl: entry.downloadUrl,
    hash: entry.hash,
    icon: entry.icon,
    engines: entry.engines,
  };
}

export async function resolveServiceRegistry(
  source: string,
  constraint?: string,
): Promise<ServiceRegistryResponse> {
  const body = await fetchRegistryJson(source, "Service");
  const descriptor = validateRegistryDescriptor(body, "Service");
  const { version, entry } = resolveRegistryVersion(
    descriptor,
    "Service",
    constraint,
  );
  return {
    version,
    downloadUrl: entry.downloadUrl,
    hash: entry.hash,
    id: entry.id,
    kind: entry.kind,
    icon: entry.icon,
  };
}

const MAX_REDIRECT_HOPS = 5;
const MAX_CAPABILITY_PAGE_BYTES = 256 * 1024;

async function fetchRegistryJsonSafe(
  url: string,
  label: string,
  options?: { maxBytes?: number; skipAuth?: boolean },
): Promise<{ finalUrl: string; body: Record<string, unknown> }> {
  let currentUrl = url;

  for (let hop = 0; ; hop++) {
    await assertRegistryAddressAllowed(currentUrl);

    if (hop > MAX_REDIRECT_HOPS) {
      throw new HttpError(502, `${label} registry redirected too many times.`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      REGISTRY_FETCH_TIMEOUT_MS,
    );

    let response: Response;
    try {
      ({ response } = await fetchWithRegistryAuth(
        currentUrl,
        {
          signal: controller.signal,
        },
        { skipAuth: options?.skipAuth },
      ));
    } catch {
      clearTimeout(timeout);
      throw new HttpError(502, `Failed to fetch ${label} registry metadata.`);
    }
    clearTimeout(timeout);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new HttpError(
          502,
          `${label} registry redirect had no Location header.`,
        );
      }
      await response.body?.cancel().catch(() => {});
      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        throw new HttpError(
          502,
          `${label} registry redirected to an invalid URL.`,
        );
      }
      if (!nextUrl.startsWith("https://") && !nextUrl.startsWith("http://")) {
        throw new HttpError(
          502,
          `${label} registry redirected to a non-http(s) URL.`,
        );
      }
      await assertRegistryAddressAllowed(nextUrl);
      currentUrl = nextUrl;
      continue;
    }

    if (!response.ok) {
      throw new HttpError(
        502,
        `${label} registry responded with status ${response.status}.`,
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await readJsonBounded(
        response,
        label,
        options?.maxBytes,
      )) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, `${label} registry returned invalid JSON.`);
    }

    return { finalUrl: currentUrl, body };
  }
}

async function readJsonBounded(
  response: Response,
  label: string,
  maxBytes?: number,
): Promise<unknown> {
  if (maxBytes !== undefined) {
    const raw = response.headers.get("content-length");
    if (raw !== null) {
      const declared = Number(raw);
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw new HttpError(
          400,
          `${label} response exceeds the maximum page size.`,
        );
      }
    }
  }

  if (!response.body) return response.json();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (maxBytes !== undefined) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new HttpError(
          400,
          `${label} response exceeds the maximum page size.`,
        );
      }
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text);
}

const CAPABILITY_KEY_PATTERN = /^(definitions|modules)\.v(\d+)$/;
const REGISTRY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface ResolvedCapability {
  version: number;
  url: string;
}

export interface ResolvedCapability {
  version: number;
  url: string;
  security?: SecurityRequirements;
}

export interface RegistryIndexInfo {
  id: string;
  finalUrl: string;
  definitions: ResolvedCapability | null;
  modules: ResolvedCapability | null;
  auth: RegistryAuthDeclaration | null;
}

export type RegistryOAuthGrantType =
  | "authorization_code"
  | "client_credentials";

export type RegistryOAuth2AuthScheme = Omit<OAuth2AuthScheme, "grantTypes"> & {
  readonly grantTypes: readonly RegistryOAuthGrantType[];
};

export type RegistryAuthScheme =
  | Exclude<AuthScheme, OAuth2AuthScheme>
  | RegistryOAuth2AuthScheme;

export interface RegistryAuthDeclaration {
  schemes: Record<string, RegistryAuthScheme>;
  security: SecurityRequirements;
}

export interface RegistryCapabilityObject {
  url: string;
  security?: SecurityRequirements;
}

export type RegistryCapabilityValue = string | RegistryCapabilityObject;

export interface RegistryWellKnownDocument {
  id: string;
  "definitions.v1"?: RegistryCapabilityValue;
  "modules.v1"?: RegistryCapabilityValue;
  auth?: RegistryAuthDeclaration;
}

export interface RegistryTokenRequest {
  grant_type: "authorization_code" | "client_credentials" | "refresh_token";
  client_id?: string;
  client_secret?: string;
  code?: string;
  redirect_uri?: string;
  code_verifier?: string;
  scope?: string;
  refresh_token?: string;
}

export interface RegistryTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
}

export interface RegistryErrorResponse {
  error: string;
}

function assertSchemeRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, `${label} must be an object.`);
  }
}

function validateAuthScheme(
  label: string,
  name: string,
  value: unknown,
  discoveryOrigin: string,
): RegistryAuthScheme {
  assertSchemeRecord(value, `${label} scheme '${name}'`);
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type === "apiKey") {
    if (record.in !== undefined && record.in !== "header") {
      throw new HttpError(
        400,
        `${label} scheme '${name}': apiKey 'in' must be 'header'.`,
      );
    }
    assertNonEmptyString(
      record.paramName,
      `${label} scheme '${name}': apiKey 'paramName' must be a non-empty string.`,
    );
    const scheme: AuthScheme = {
      type: "apiKey",
      in: "header",
      paramName: (record.paramName as string).trim(),
    };
    if (record.prefix !== undefined) {
      assertNonEmptyString(
        record.prefix,
        `${label} scheme '${name}': apiKey 'prefix' must be a non-empty string if provided.`,
      );
      (scheme as { prefix: string }).prefix = (record.prefix as string).trim();
    }
    return scheme;
  }
  if (type === "basic") {
    return { type: "basic" };
  }
  if (type === "http") {
    if (record.scheme !== "bearer") {
      throw new HttpError(
        400,
        `${label} scheme '${name}': http 'scheme' must be 'bearer'.`,
      );
    }
    return { type: "http", scheme: "bearer" };
  }
  if (type === "oauth2") {
    if (!Array.isArray(record.grantTypes) || record.grantTypes.length === 0) {
      throw new HttpError(
        400,
        `${label} scheme '${name}': oauth2 'grantTypes' must be a non-empty array.`,
      );
    }
    const grants = record.grantTypes as unknown[];
    for (const grant of grants) {
      if (grant !== "authorization_code" && grant !== "client_credentials") {
        throw new HttpError(
          400,
          `${label} scheme '${name}': unsupported oauth2 grant '${String(grant)}'; only 'authorization_code' and 'client_credentials' are supported.`,
        );
      }
    }
    assertNonEmptyString(
      record.tokenUrl,
      `${label} scheme '${name}': oauth2 'tokenUrl' must be a non-empty string.`,
    );
    const tokenUrl = (record.tokenUrl as string).trim();
    assertSameOriginHttpUrl(tokenUrl, discoveryOrigin, label, name, "tokenUrl");
    let authorizationUrl: string | undefined;
    if (
      (grants as string[]).includes("authorization_code") ||
      record.authorizationUrl !== undefined
    ) {
      assertNonEmptyString(
        record.authorizationUrl,
        `${label} scheme '${name}': oauth2 'authorizationUrl' is required when 'authorization_code' is granted.`,
      );
      authorizationUrl = (record.authorizationUrl as string).trim();
      assertSameOriginHttpUrl(
        authorizationUrl,
        discoveryOrigin,
        label,
        name,
        "authorizationUrl",
      );
    }
    const scopes: Record<string, string> = {};
    if (record.scopes !== undefined) {
      assertSchemeRecord(record.scopes, `${label} scheme '${name}' 'scopes'`);
      for (const [scopeId, description] of Object.entries(
        record.scopes as Record<string, unknown>,
      )) {
        if (scopeId.trim().length === 0 || typeof description !== "string") {
          throw new HttpError(
            400,
            `${label} scheme '${name}': oauth2 'scopes' must map non-empty ids to description strings.`,
          );
        }
        scopes[scopeId.trim()] = description;
      }
    }
    return {
      type: "oauth2",
      grantTypes: grants as RegistryOAuthGrantType[],
      ...(authorizationUrl !== undefined ? { authorizationUrl } : {}),
      tokenUrl,
      scopes,
      tokenPlacement: {
        in: "header",
        paramName: "Authorization",
        prefix: "Bearer",
      },
    };
  }
  throw new HttpError(
    400,
    `${label} scheme '${name}': unsupported auth type '${typeof type === "string" ? type : "unknown"}'.`,
  );
}

function assertSameOriginHttpUrl(
  value: string,
  discoveryOrigin: string,
  label: string,
  schemeName: string,
  field: string,
): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(
      400,
      `${label} scheme '${schemeName}': '${field}' must be a valid absolute URL.`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(
      400,
      `${label} scheme '${schemeName}': '${field}' must be an http(s) URL.`,
    );
  }
  if (parsed.origin !== discoveryOrigin) {
    throw new HttpError(
      400,
      `${label} scheme '${schemeName}': '${field}' must be on the registry's origin.`,
    );
  }
}

function validateSecurity(
  label: string,
  value: unknown,
  schemes: Record<string, RegistryAuthScheme>,
): SecurityRequirements {
  if (!Array.isArray(value)) {
    throw new HttpError(400, `${label} 'security' must be an array.`);
  }
  const requirements: SecurityRequirement[] = [];
  for (const [index, requirement] of value.entries()) {
    assertSchemeRecord(requirement, `${label} 'security[${index}]'`);
    const group: Record<string, string[]> = {};
    for (const [schemeName, scopes] of Object.entries(
      requirement as Record<string, unknown>,
    )) {
      const scheme = schemes[schemeName];
      if (!scheme) {
        throw new HttpError(
          400,
          `${label} 'security[${index}]' references undeclared scheme '${schemeName}'.`,
        );
      }
      if (
        !Array.isArray(scopes) ||
        !scopes.every((s) => typeof s === "string")
      ) {
        throw new HttpError(
          400,
          `${label} 'security[${index}]['${schemeName}'] must be a string array.`,
        );
      }
      if (scopes.length > 0 && scheme.type !== "oauth2") {
        throw new HttpError(
          400,
          `${label} 'security[${index}]['${schemeName}'] must be empty: only oauth2 schemes support scopes.`,
        );
      }
      if (scheme.type === "oauth2") {
        const declared = Object.keys(scheme.scopes);
        const undeclared = (scopes as string[]).filter(
          (s) => !declared.includes(s),
        );
        if (undeclared.length > 0) {
          throw new HttpError(
            400,
            `${label} 'security[${index}]['${schemeName}'] references undeclared scopes: ${undeclared.join(", ")}.`,
          );
        }
      }
      group[schemeName] = scopes as string[];
    }
    requirements.push(group);
  }
  return requirements;
}

const SUPPORTED_DEFINITIONS_VERSIONS = [1] as const;
const SUPPORTED_MODULES_VERSIONS = [1] as const;

function resolveCapability(
  body: Record<string, unknown>,
  capability: "definitions" | "modules",
  supported: readonly number[],
  finalUrl: string,
  label: string,
  schemes: Record<string, RegistryAuthScheme>,
): ResolvedCapability | null {
  const offered: { version: number; value: unknown }[] = [];

  for (const [key, value] of Object.entries(body)) {
    const match = key.match(CAPABILITY_KEY_PATTERN);
    if (!match || match[1] !== capability) continue;
    if (typeof value !== "string") {
      assertSchemeRecord(
        value,
        `${label} registry '${key}' must be a non-empty string or { url, security } object.`,
      );
    } else {
      assertNonEmptyString(
        value,
        `${label} registry '${key}' must be a non-empty string.`,
      );
    }
    offered.push({ version: Number(match[2]), value });
  }

  const best = offered
    .filter((entry) => supported.includes(entry.version))
    .sort((a, b) => b.version - a.version)[0];

  if (!best) return null;

  let rawUrl: string;
  let security: SecurityRequirements | undefined;
  if (typeof best.value === "string") {
    rawUrl = best.value.trim();
  } else {
    const record = best.value as Record<string, unknown>;
    assertNonEmptyString(
      record.url,
      `${label} registry '${capability}.v${best.version}' object form must include a non-empty 'url' string.`,
    );
    rawUrl = (record.url as string).trim();
    if (record.security !== undefined) {
      security = validateSecurity(
        `${label} registry '${capability}.v${best.version}'`,
        record.security,
        schemes,
      );
    }
  }

  const resolved = new URL(rawUrl, finalUrl);
  const discoveryOrigin = new URL(finalUrl).origin;

  if (resolved.origin !== discoveryOrigin) {
    throw new HttpError(
      400,
      `${label} registry '${capability}.v${best.version}' must resolve to the same origin as the registry.`,
    );
  }

  return {
    version: best.version,
    url: resolved.toString(),
    ...(security !== undefined ? { security } : {}),
  };
}

function parseAdvertisedAuth(
  body: Record<string, unknown>,
  label: string,
  _discoveryUrl: string,
  discoveryOrigin: string,
): RegistryAuthDeclaration | null {
  const auth = body.auth;
  if (auth === undefined) return null;

  assertSchemeRecord(auth, `${label} registry 'auth'`);
  const record = auth as Record<string, unknown>;

  if (
    record.schemes === undefined ||
    typeof record.schemes !== "object" ||
    record.schemes === null ||
    Array.isArray(record.schemes) ||
    Object.keys(record.schemes).length === 0
  ) {
    throw new HttpError(
      400,
      `${label} registry 'auth.schemes' must declare at least one scheme.`,
    );
  }
  const schemes: Record<string, RegistryAuthScheme> = {};
  for (const [name, scheme] of Object.entries(
    record.schemes as Record<string, unknown>,
  )) {
    if (name.trim().length === 0) {
      throw new HttpError(
        400,
        `${label} registry 'auth.schemes' keys must be non-empty strings.`,
      );
    }
    schemes[name] = validateAuthScheme(
      `${label} registry 'auth'`,
      name,
      scheme,
      discoveryOrigin,
    );
  }
  if (record.security === undefined) {
    throw new HttpError(
      400,
      `${label} registry 'auth.security' must be an array (use [] for a public registry).`,
    );
  }
  const security = validateSecurity(
    `${label} registry 'auth'`,
    record.security,
    schemes,
  );
  return { schemes, security };
}

export async function fetchRegistryIndex(
  baseUrl: string,
): Promise<RegistryIndexInfo> {
  const discoveryUrl = new URL(
    "/.well-known/registry.json",
    baseUrl,
  ).toString();
  const { finalUrl, body } = await fetchRegistryJsonSafe(
    discoveryUrl,
    "well-known",
    { skipAuth: true },
  );

  assertNonEmptyString(
    body.id,
    "Registry well-known response must include a non-empty 'id' string.",
  );
  if (!REGISTRY_ID_PATTERN.test(body.id.trim())) {
    throw new HttpError(
      400,
      `Registry id '${body.id}' must be a slug matching /^[A-Za-z0-9_-]+$/.`,
    );
  }

  const discoveryOrigin = new URL(finalUrl).origin;
  const auth = parseAdvertisedAuth(
    body,
    "Well-known",
    finalUrl,
    discoveryOrigin,
  );
  const schemes = auth?.schemes ?? {};

  return {
    id: body.id.trim(),
    finalUrl,
    definitions: resolveCapability(
      body,
      "definitions",
      SUPPORTED_DEFINITIONS_VERSIONS,
      finalUrl,
      "Well-known",
      schemes,
    ),
    modules: resolveCapability(
      body,
      "modules",
      SUPPORTED_MODULES_VERSIONS,
      finalUrl,
      "Well-known",
      schemes,
    ),
    auth,
  };
}

export function effectiveSecurityForUrl(
  index: RegistryIndexInfo,
  url: string,
): SecurityRequirements {
  const global = index.auth?.security ?? [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return global;
  }
  const prefixMatches = (
    capability: { url: string } | null | undefined,
  ): boolean => {
    if (!capability) return false;
    try {
      const base = new URL(capability.url);
      return (
        base.origin === parsed.origin &&
        parsed.pathname.startsWith(base.pathname)
      );
    } catch {
      return false;
    }
  };
  const firstSegment = (pathname: string): string | undefined =>
    pathname.split("/").filter(Boolean)[0];
  const segmentMatches = (
    capability: { url: string } | null | undefined,
  ): boolean => {
    if (!capability) return false;
    try {
      const base = new URL(capability.url);
      if (base.origin !== parsed.origin) return false;
      const baseSeg = firstSegment(base.pathname);
      const reqSeg = firstSegment(parsed.pathname);
      return baseSeg !== undefined && baseSeg === reqSeg;
    } catch {
      return false;
    }
  };
  const definitionsPrefix = prefixMatches(index.definitions);
  const modulesPrefix = prefixMatches(index.modules);
  if (definitionsPrefix !== modulesPrefix) {
    const matched = definitionsPrefix ? index.definitions : index.modules;
    if (matched?.security !== undefined) return matched.security;
    return global;
  }
  if (definitionsPrefix && modulesPrefix) {
    const defLen = index.definitions?.url.length ?? 0;
    const modLen = index.modules?.url.length ?? 0;
    const longer = defLen >= modLen ? index.definitions : index.modules;
    if (longer?.security !== undefined) return longer.security;
    return global;
  }
  const definitionsSeg = segmentMatches(index.definitions);
  const modulesSeg = segmentMatches(index.modules);
  if (definitionsSeg !== modulesSeg) {
    const matched = definitionsSeg ? index.definitions : index.modules;
    if (matched?.security !== undefined) return matched.security;
  }
  return global;
}

const indexCache = new Map<string, { index: RegistryIndexInfo; at: number }>();
const INDEX_CACHE_TTL_MS = 5 * 60 * 1000;

export function invalidateRegistryIndexCache(baseUrl?: string): void {
  if (baseUrl === undefined) {
    indexCache.clear();
    return;
  }
  indexCache.delete(baseUrl);
}

export async function fetchCachedRegistryIndex(
  baseUrl: string,
): Promise<RegistryIndexInfo> {
  const cached = indexCache.get(baseUrl);
  if (cached && Date.now() - cached.at < INDEX_CACHE_TTL_MS) {
    return cached.index;
  }
  const index = await fetchRegistryIndex(baseUrl);
  indexCache.set(baseUrl, { index, at: Date.now() });
  return index;
}

export interface RegistryEntry {
  id: string;
  name?: string;
  description?: string;
  source: string;
  kind?: string;
  type?: "adapter" | "environment";
  icon?: RegistryIcon;
}

export interface RegistryPage {
  entries: RegistryEntry[];
  nextCursor: string | null;
}

export interface RegistryDefinitionsWirePage {
  definitions: RegistryEntry[];
  nextCursor: string | null;
}

export interface RegistryModulesWirePage {
  modules: RegistryEntry[];
  nextCursor: string | null;
}

function assertEntry(
  value: unknown,
  capability: "definitions" | "modules",
  capabilityUrl: string,
): RegistryEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, `${capability} entry must be an object.`);
  }
  const entry = value as Record<string, unknown>;

  assertNonEmptyString(
    entry.id,
    `${capability} entry must include a non-empty 'id'.`,
  );
  if (!REGISTRY_ID_PATTERN.test(entry.id.trim())) {
    throw new HttpError(
      400,
      `${capability} entry id '${entry.id}' must be a slug.`,
    );
  }
  assertNonEmptyString(
    entry.source,
    `${capability} entry '${entry.id}' must include a non-empty 'source'.`,
  );

  const resolvedSource = new URL(entry.source.trim(), capabilityUrl);
  if (resolvedSource.origin !== new URL(capabilityUrl).origin) {
    throw new HttpError(
      400,
      `${capability} entry '${entry.id}' source must resolve to the registry's origin.`,
    );
  }

  if (capability === "modules") {
    assertNonEmptyString(
      entry.type,
      `modules entry '${entry.id}' must include a non-empty 'type'.`,
    );
    if (entry.type !== "adapter" && entry.type !== "environment") {
      throw new HttpError(
        400,
        `modules entry '${entry.id}' type must be 'adapter' or 'environment'.`,
      );
    }
  }

  const kind =
    capability === "definitions"
      ? normalizeOptionalString(
          entry.kind,
          `definitions entry '${entry.id}' kind must be a string if provided.`,
        )
      : undefined;
  if (kind !== undefined) {
    assertKind(
      kind,
      `definitions entry '${entry.id}' kind must match <identifier>@<version>, e.g. 'openapi@3.0'.`,
    );
  }

  const icon = entry.icon;
  if (icon !== undefined && typeof icon !== "object") {
    throw new HttpError(
      400,
      `${capability} entry '${entry.id}' 'icon' must be an object if provided.`,
    );
  }
  const iconUrl = normalizeOptionalString(
    (icon as Record<string, unknown> | undefined)?.url,
    `${capability} entry '${entry.id}' 'icon.url' must be a non-empty string if provided.`,
  );
  const iconHash = normalizeOptionalString(
    (icon as Record<string, unknown> | undefined)?.hash,
    `${capability} entry '${entry.id}' 'icon.hash' must be a non-empty string if provided.`,
  );
  if (icon !== undefined && (iconUrl === undefined || iconHash === undefined)) {
    throw new HttpError(
      400,
      `${capability} entry '${entry.id}' 'icon' must include non-empty 'url' and 'hash' strings.`,
    );
  }

  return {
    id: entry.id.trim(),
    name: normalizeOptionalString(
      entry.name,
      `${capability} entry '${entry.id}' name must be a string if provided.`,
    ),
    description: normalizeOptionalString(
      entry.description,
      `${capability} entry '${entry.id}' description must be a string if provided.`,
    ),
    source: resolvedSource.toString(),
    kind,
    type:
      capability === "modules"
        ? (entry.type as "adapter" | "environment")
        : undefined,
    icon:
      iconUrl === undefined || iconHash === undefined
        ? undefined
        : { url: iconUrl, hash: iconHash },
  };
}

export async function fetchRegistryCapabilityPage(
  capabilityUrl: string,
  capability: "definitions" | "modules",
  params: {
    query?: string;
    type?: string;
    kind?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<RegistryPage> {
  const url = new URL(capabilityUrl);
  if (params.query) url.searchParams.set("query", params.query);
  if (params.type) url.searchParams.set("type", params.type);
  if (params.kind) url.searchParams.set("kind", params.kind);
  if (params.cursor) url.searchParams.set("cursor", params.cursor);
  url.searchParams.set("limit", String(params.limit ?? 50));

  const { body } = await fetchRegistryJsonSafe(url.toString(), capability, {
    maxBytes: MAX_CAPABILITY_PAGE_BYTES,
  });

  const rawEntries = body[capability];
  if (!Array.isArray(rawEntries)) {
    throw new HttpError(
      400,
      `${capability} response must include a '${capability}' array.`,
    );
  }

  const nextCursor = body.nextCursor;
  if (
    nextCursor !== undefined &&
    nextCursor !== null &&
    typeof nextCursor !== "string"
  ) {
    throw new HttpError(
      400,
      `${capability} response 'nextCursor' must be a string or null.`,
    );
  }

  return {
    entries: rawEntries.map((entry) =>
      assertEntry(entry, capability, capabilityUrl),
    ),
    nextCursor: nextCursor ?? null,
  };
}
