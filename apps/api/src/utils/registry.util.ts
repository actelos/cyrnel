import { maxSatisfying, valid } from "semver";

import { HttpError } from "@/models/error.model";
import { assertRegistryAddressAllowed } from "@/utils/download.util";

const REGISTRY_FETCH_TIMEOUT_MS = 10_000;

interface RegistryVersionEntry {
  downloadUrl: string;
  hash?: string;
  id?: string;
  adapter?: string;
  engines?: {
    cyrnel?: string;
  };
}

interface VersionedRegistryDescriptor {
  latestVersion: string;
  versions: Record<string, RegistryVersionEntry>;
}

export interface ModuleRegistryResponse {
  version: string;
  downloadUrl: string;
  hash?: string;
  engines?: {
    cyrnel?: string;
  };
}

export interface ServiceRegistryResponse {
  version: string;
  downloadUrl: string;
  hash?: string;
  id?: string;
  adapter?: string;
}

async function fetchRegistryJson(
  source: string,
  label: string,
): Promise<Record<string, unknown>> {
  await assertRegistryAddressAllowed(source);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REGISTRY_FETCH_TIMEOUT_MS,
  );

  let response: Response;
  try {
    response = await fetch(source, { signal: controller.signal });
  } catch {
    clearTimeout(timeout);
    throw new HttpError(502, `Failed to fetch ${label} registry metadata.`);
  }
  clearTimeout(timeout);

  if (!response.ok) {
    throw new HttpError(
      502,
      `${label} registry responded with status ${response.status}.`,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, `${label} registry returned invalid JSON.`);
  }

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
    adapter: normalizeOptionalString(
      entry.adapter,
      `${label} registry version '${version}' 'adapter' must be a non-empty string if provided.`,
    ),
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
    adapter: entry.adapter,
  };
}
