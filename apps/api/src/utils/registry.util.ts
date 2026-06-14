import { HttpError } from "@/models/error.model";
import { assertRegistryAddressAllowed } from "@/utils/download.util";

const REGISTRY_FETCH_TIMEOUT_MS = 10_000;

export interface ModuleRegistryResponse {
  downloadUrl: string;
  hash?: string;
}

export interface ServiceRegistryResponse {
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

function validateModuleRegistryResponse(
  body: Record<string, unknown>,
): ModuleRegistryResponse {
  const downloadUrl = body.downloadUrl;
  if (typeof downloadUrl !== "string" || downloadUrl.trim().length === 0) {
    throw new HttpError(
      400,
      "Module registry response must include a non-empty 'downloadUrl' string.",
    );
  }

  const hash = body.hash;
  if (
    hash !== undefined &&
    (typeof hash !== "string" || hash.trim().length === 0)
  ) {
    throw new HttpError(
      400,
      "Module registry response 'hash' must be a non-empty string if provided.",
    );
  }

  return { downloadUrl: downloadUrl.trim(), hash: hash?.trim() };
}

function validateServiceRegistryResponse(
  body: Record<string, unknown>,
): ServiceRegistryResponse {
  const downloadUrl = body.downloadUrl;
  if (typeof downloadUrl !== "string" || downloadUrl.trim().length === 0) {
    throw new HttpError(
      400,
      "Service registry response must include a non-empty 'downloadUrl' string.",
    );
  }

  const hash = body.hash;
  if (
    hash !== undefined &&
    (typeof hash !== "string" || hash.trim().length === 0)
  ) {
    throw new HttpError(
      400,
      "Service registry response 'hash' must be a non-empty string if provided.",
    );
  }

  const id = body.id;
  if (id !== undefined && (typeof id !== "string" || id.trim().length === 0)) {
    throw new HttpError(
      400,
      "Service registry response 'id' must be a non-empty string if provided.",
    );
  }

  const adapter = body.adapter;
  if (
    adapter !== undefined &&
    (typeof adapter !== "string" || adapter.trim().length === 0)
  ) {
    throw new HttpError(
      400,
      "Service registry response 'adapter' must be a non-empty string if provided.",
    );
  }

  return {
    downloadUrl: downloadUrl.trim(),
    hash: hash?.trim(),
    id: id?.trim(),
    adapter: adapter?.trim(),
  };
}

export async function resolveModuleRegistry(
  source: string,
): Promise<ModuleRegistryResponse> {
  const body = await fetchRegistryJson(source, "Module");
  return validateModuleRegistryResponse(body);
}

export async function resolveServiceRegistry(
  source: string,
): Promise<ServiceRegistryResponse> {
  const body = await fetchRegistryJson(source, "Service");
  return validateServiceRegistryResponse(body);
}
