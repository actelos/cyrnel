import { z } from "zod";

import type {
  ManifestMetadata,
  ServiceManifest,
} from "@/models/manifest.model";

const recordSchema = z.record(z.string(), z.unknown());

const manifestToolSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string(),
  enabled: z.boolean(),
  inputSchema: recordSchema,
  outputSchema: recordSchema,
  metadata: recordSchema,
});

const serviceManifestSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string(),
  enabled: z.boolean(),
  configSchema: recordSchema,
  metadata: recordSchema,
  tools: z.array(manifestToolSchema),
});

const adapterErrorPayloadSchema = z.object({
  message: z.unknown().optional(),
  error: z
    .object({
      message: z.unknown().optional(),
    })
    .optional(),
});

interface AdapterModuleOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface AdapterInvokeMetadata {
  serviceMetadata: ManifestMetadata;
  toolMetadata: ManifestMetadata;
}

export class AdapterModule {
  private readonly fetchImpl: typeof fetch;
  private serviceConfigSnapshot: Record<string, unknown> = {};

  constructor(options: AdapterModuleOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async register(definitionContent: string): Promise<ServiceManifest> {
    return parseServiceManifest(definitionContent);
  }

  setServiceConfigs(snapshot: Record<string, unknown>): void {
    this.serviceConfigSnapshot = snapshot;
  }

  getServiceConfig(serviceName: string): Record<string, unknown> {
    const value = this.serviceConfigSnapshot[serviceName];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }

    return {};
  }

  async invoke(
    serviceName: string,
    toolName: string,
    parameters: Record<string, unknown>,
    metadata?: AdapterInvokeMetadata,
  ): Promise<unknown> {
    const normalizedToolName = normalizeToolName(toolName);
    const baseUrl = resolveInvocationBaseUrl(metadata?.serviceMetadata);
    const routeName = resolveToolRouteName(
      normalizedToolName,
      metadata?.toolMetadata,
    );
    const endpoint = buildToolEndpoint(baseUrl, routeName);
    const requestKind = resolveToolRequestKind(metadata?.toolMetadata);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };

    if (requestKind) {
      headers["x-mci-request-kind"] = requestKind;
    }

    try {
      headers["x-mci-service-config"] = JSON.stringify(
        this.getServiceConfig(serviceName),
      );
    } catch {
      headers["x-mci-service-config"] = "{}";
    }

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(parameters),
      });
    } catch (error) {
      throw new Error(
        `Failed to invoke tool '${normalizedToolName}' at '${endpoint}': ${toErrorMessage(error)}`,
      );
    }

    const payload = await parseJsonSafely(response);

    if (!response.ok) {
      throw new Error(
        `Tool '${normalizedToolName}' request failed with status ${response.status}: ${extractErrorMessage(payload)}`,
      );
    }

    if (isWrappedOutput(payload)) {
      return payload.output;
    }

    return payload;
  }
}

export function parseServiceManifest(manifestSource: string): ServiceManifest {
  const normalized = manifestSource.trim();

  if (!normalized) {
    throw new Error("Manifest JSON must not be empty.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new Error("Manifest JSON is invalid.");
  }

  const validation = serviceManifestSchema.safeParse(parsed);
  if (!validation.success) {
    throw new Error("Manifest JSON is not a valid service manifest.");
  }

  return validation.data;
}

function resolveInvocationBaseUrl(
  serviceMetadata: ManifestMetadata | undefined,
): string {
  if (!serviceMetadata) {
    throw new Error(
      "Service metadata is required to resolve the adapter URL from the service manifest.",
    );
  }

  const candidate = extractStringValue(serviceMetadata, [
    "adapterUrl",
    "serverUrl",
    "baseUrl",
    "url",
    "address",
    "endpoint",
  ]);

  if (!candidate) {
    throw new Error("Service manifest metadata must include an adapter URL.");
  }

  return resolveAdapterBaseUrl(candidate);
}

function resolveToolRouteName(
  fallbackToolName: string,
  toolMetadata: ManifestMetadata | undefined,
): string {
  if (!toolMetadata) {
    return fallbackToolName;
  }

  const route = extractStringValue(toolMetadata, [
    "route",
    "routeName",
    "path",
    "endpoint",
    "toolRoute",
  ]);

  return route ?? fallbackToolName;
}

function resolveToolRequestKind(
  toolMetadata: ManifestMetadata | undefined,
): string | undefined {
  if (!toolMetadata) {
    return undefined;
  }

  return extractStringValue(toolMetadata, [
    "requestKind",
    "kind",
    "requestType",
  ]);
}

function extractStringValue(
  source: ManifestMetadata,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const candidate = source[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return undefined;
}

function resolveAdapterBaseUrl(rawValue: string | undefined): string {
  const chosen = rawValue?.trim();

  if (!chosen) {
    throw new Error("Adapter URL must not be empty.");
  }

  try {
    const parsed = new URL(chosen);
    return parsed.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`Invalid adapter URL '${chosen}'.`);
  }
}

function normalizeToolName(toolName: string): string {
  const parsed = z
    .string()
    .trim()
    .min(1, { error: "Tool name must not be empty." })
    .safeParse(toolName);

  if (!parsed.success) {
    throw new Error(
      parsed.error.issues[0]?.message ?? "Tool name must not be empty.",
    );
  }

  return parsed.data;
}

function buildToolEndpoint(baseUrl: string, toolName: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(encodeURIComponent(toolName), base);
  return url.toString();
}

async function parseJsonSafely(response: Response): Promise<unknown> {
  const raw = await response.text();

  if (!raw.trim()) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Adapter response was not valid JSON.");
  }
}

function isWrappedOutput(payload: unknown): payload is { output: unknown } {
  return (
    !!payload && typeof payload === "object" && Object.hasOwn(payload, "output")
  );
}

function extractErrorMessage(payload: unknown): string {
  const parsed = adapterErrorPayloadSchema.safeParse(payload);

  if (!parsed.success) {
    return "Unknown adapter error.";
  }

  const candidate = parsed.data;

  if (typeof candidate.message === "string" && candidate.message.trim()) {
    return candidate.message;
  }

  if (
    typeof candidate.error?.message === "string" &&
    candidate.error.message.trim()
  ) {
    return candidate.error.message;
  }

  return "Unknown adapter error.";
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function _isRecord(value: unknown): value is Record<string, unknown> {
  return recordSchema.safeParse(value).success;
}
