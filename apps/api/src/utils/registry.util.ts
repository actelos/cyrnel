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

interface VersionedRegistryDescriptor {
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

/**
 * JSON fetch with per-hop redirect re-validation. Unlike `fetchRegistryJson`,
 * redirects are followed manually so every hop runs
 * `assertRegistryAddressAllowed` (the same guard `fetchStream` applies for
 * downloads). The final URL is returned because relative capability URLs
 * resolve against the post-redirect URL, not the caller-supplied one.
 */
async function fetchRegistryJsonSafe(
  url: string,
  label: string,
  options?: { maxBytes?: number },
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
      ({ response } = await fetchWithRegistryAuth(currentUrl, {
        signal: controller.signal,
      }));
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
      currentUrl = new URL(location, currentUrl).toString();
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

export interface RegistryIndexInfo {
  id: string;
  finalUrl: string;
  definitions: ResolvedCapability | null;
  modules: ResolvedCapability | null;
  auth: RegistryAuthDeclaration | null;
}

export interface RegistryAuthScope {
  id: string;
  description?: string;
}

export type RegistryAuthDeclaration =
  | { type: "apiKey"; name: string }
  | {
      type: "oauth2";
      grantType: "client_credentials";
      tokenEndpoint: string;
      scopes?: RegistryAuthScope[];
    }
  | { type: "unsupported"; declaredType: string; reason?: string };

function isRegistryAuthScope(
  value: unknown,
): value is { id: string; description?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim().length === 0) {
    return false;
  }
  return (
    record.description === undefined || typeof record.description === "string"
  );
}

const SUPPORTED_DEFINITIONS_VERSIONS = [1] as const;
const SUPPORTED_MODULES_VERSIONS = [1] as const;

function resolveCapability(
  body: Record<string, unknown>,
  capability: "definitions" | "modules",
  supported: readonly number[],
  finalUrl: string,
  label: string,
): ResolvedCapability | null {
  const offered: { version: number; url: string }[] = [];

  for (const [key, value] of Object.entries(body)) {
    const match = key.match(CAPABILITY_KEY_PATTERN);
    if (!match || match[1] !== capability) continue;
    assertNonEmptyString(
      value,
      `${label} registry '${key}' must be a non-empty string.`,
    );
    offered.push({ version: Number(match[2]), url: value.trim() });
  }

  const best = offered
    .filter((entry) => supported.includes(entry.version))
    .sort((a, b) => b.version - a.version)[0];

  if (!best) return null;

  const resolved = new URL(best.url, finalUrl);
  const discoveryOrigin = new URL(finalUrl).origin;

  if (resolved.origin !== discoveryOrigin) {
    throw new HttpError(
      400,
      `${label} registry '${capability}.v${best.version}' must resolve to the same origin as the registry.`,
    );
  }

  return { version: best.version, url: resolved.toString() };
}

function parseAdvertisedAuth(
  body: Record<string, unknown>,
  label: string,
  discoveryUrl: string,
): RegistryAuthDeclaration | null {
  const auth = body.auth;
  if (auth === undefined) return null;

  if (typeof auth !== "object" || auth === null || Array.isArray(auth)) {
    throw new HttpError(
      400,
      `${label} registry 'auth' must be an object if provided.`,
    );
  }

  const record = auth as Record<string, unknown>;
  if (typeof record.type !== "string" || record.type.trim().length === 0) {
    throw new HttpError(
      400,
      `${label} registry 'auth.type' must be a non-empty string.`,
    );
  }

  if (record.type === "apiKey") {
    if (record.in !== undefined && record.in !== "header") {
      return {
        type: "unsupported",
        declaredType: "apiKey",
        reason:
          "'in' must be 'header'; query-param api keys are not supported.",
      };
    }
    assertNonEmptyString(
      record.name,
      `${label} registry apiKey 'auth.name' must be a non-empty string.`,
    );
    return { type: "apiKey", name: record.name.trim() };
  }

  if (record.type === "oauth2") {
    if (
      record.grantType !== undefined &&
      record.grantType !== "client_credentials"
    ) {
      return {
        type: "unsupported",
        declaredType: "oauth2",
        reason: `grant '${record.grantType}' is not supported; only 'client_credentials' is.`,
      };
    }
    assertNonEmptyString(
      record.tokenEndpoint,
      `${label} registry oauth2 'auth.tokenEndpoint' must be a non-empty string.`,
    );
    const tokenEndpoint = record.tokenEndpoint.trim();
    let parsed: URL;
    try {
      parsed = new URL(tokenEndpoint);
    } catch {
      throw new HttpError(
        400,
        `${label} registry oauth2 'auth.tokenEndpoint' must be a valid absolute URL.`,
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new HttpError(
        400,
        `${label} registry oauth2 'auth.tokenEndpoint' must be an http(s) URL.`,
      );
    }
    if (parsed.origin !== new URL(discoveryUrl).origin) {
      throw new HttpError(
        400,
        `${label} registry oauth2 'auth.tokenEndpoint' must be on the registry's origin.`,
      );
    }

    let scopes: RegistryAuthScope[] | undefined;
    if (record.scopes !== undefined) {
      if (
        !Array.isArray(record.scopes) ||
        !record.scopes.every(isRegistryAuthScope)
      ) {
        throw new HttpError(
          400,
          `${label} registry oauth2 'auth.scopes' must be an array of { id, description } objects if provided.`,
        );
      }
      scopes = record.scopes.map((scope) => ({
        id: scope.id.trim(),
        ...(scope.description !== undefined
          ? { description: scope.description.trim() }
          : {}),
      }));
    }

    return {
      type: "oauth2",
      grantType: "client_credentials",
      tokenEndpoint,
      scopes,
    };
  }

  return { type: "unsupported", declaredType: record.type };
}

/**
 * Discovers and negotiates a registry's capabilities from its well-known
 * document. Unrecognized keys (including a `name` key) are ignored for
 * forward compatibility.
 */
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

  return {
    id: body.id.trim(),
    finalUrl,
    definitions: resolveCapability(
      body,
      "definitions",
      SUPPORTED_DEFINITIONS_VERSIONS,
      finalUrl,
      "Well-known",
    ),
    modules: resolveCapability(
      body,
      "modules",
      SUPPORTED_MODULES_VERSIONS,
      finalUrl,
      "Well-known",
    ),
    auth: parseAdvertisedAuth(body, "Well-known", finalUrl),
  };
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

/**
 * Fetches and validates one page of a registry capability endpoint. All
 * filtering is advisory: query params are forwarded untouched and entries are
 * never filtered client-side, since that would break pagination.
 */
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
