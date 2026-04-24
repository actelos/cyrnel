import { isIP } from "node:net";

import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { manifests, tools } from "@/db/schema";
import { HttpError } from "@/models/error.model";
import type { ResolvedToolInvocation } from "@/models/invoke.model";
import type {
  ManifestMetadata,
  PublicToolDefinition,
  ServiceInstallRequest,
  ServiceManifest,
  ServiceManifestDetails,
  ServiceManifestResponse,
  ServiceType,
  ToolDefinition,
  ToolDefinitionResponse,
} from "@/models/manifest.model";
import { AdapterModule } from "@/modules/adapter.module";
import { computeContentHash } from "@/utils/hash.util";

const DEFINITION_DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_DEFINITION_DOWNLOAD_BYTES = 2_048_576;

type ServiceMetadataLoader = (
  serviceName: string,
) => Promise<{ metadata: ManifestMetadata; enabled: boolean } | null>;
type ToolLoader = (
  serviceName: string,
  toolName: string,
) => Promise<ToolDefinition | null>;

export class ManifestService {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly loadServiceMetadata: ServiceMetadataLoader = loadServiceMetadataByServiceName,
    private readonly loadToolByName: ToolLoader = loadToolByServiceAndToolName,
    private readonly adapter: AdapterModule = new AdapterModule(),
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  async listServices(query?: string): Promise<ServiceManifestResponse[]> {
    let rows: Array<{
      id: string;
      type: ServiceType;
      source: string;
      description: string;
      hash: string;
      enabled: boolean;
    }>;

    try {
      rows = await db
        .select({
          id: manifests.id,
          type: manifests.type,
          source: manifests.source,
          description: manifests.description,
          hash: manifests.hash,
          enabled: manifests.enabled,
        })
        .from(manifests)
        .orderBy(asc(manifests.id));
    } catch {
      throw new HttpError(500, "Failed to list service manifests.");
    }

    const loweredQuery = query?.toLowerCase();

    const filtered =
      loweredQuery === undefined
        ? rows
        : rows.filter(
            (row) =>
              row.id.toLowerCase().includes(loweredQuery) ||
              row.description.toLowerCase().includes(loweredQuery),
          );

    return filtered.map((row) => ({
      name: row.id,
      type: row.type,
      source: row.source,
      description: row.description,
      hash: row.hash,
      enabled: row.enabled,
    }));
  }

  async getService(serviceName: string): Promise<ServiceManifestDetails> {
    const normalizedServiceName = normalizeServiceName(serviceName);

    let rows: Array<{
      id: string;
      type: ServiceType;
      source: string;
      description: string;
      metadata: ManifestMetadata;
      hash: string;
      enabled: boolean;
    }>;
    try {
      rows = await db
        .select({
          id: manifests.id,
          type: manifests.type,
          source: manifests.source,
          description: manifests.description,
          metadata: manifests.metadata,
          hash: manifests.hash,
          enabled: manifests.enabled,
        })
        .from(manifests)
        .where(eq(manifests.id, normalizedServiceName))
        .limit(1);
    } catch {
      throw new HttpError(
        500,
        `Failed to load manifest for service '${normalizedServiceName}'.`,
      );
    }

    if (rows.length === 0) {
      throw new HttpError(
        404,
        `Manifest not found for service '${normalizedServiceName}'.`,
      );
    }

    const metadata = rows[0].metadata;
    if (!isRecord(metadata)) {
      throw new HttpError(
        500,
        `Stored manifest for service '${normalizedServiceName}' has invalid metadata.`,
      );
    }

    return {
      name: rows[0].id,
      type: rows[0].type,
      source: rows[0].source,
      description: rows[0].description,
      hash: rows[0].hash,
      enabled: rows[0].enabled,
      metadata,
    };
  }

  async listTools(
    serviceName: string,
    query?: string,
  ): Promise<PublicToolDefinition[]> {
    const normalizedServiceName = normalizeServiceName(serviceName);

    let serviceRows: Array<{ id: string; enabled: boolean }>;
    try {
      serviceRows = await db
        .select({ id: manifests.id, enabled: manifests.enabled })
        .from(manifests)
        .where(eq(manifests.id, normalizedServiceName))
        .limit(1);
    } catch {
      throw new HttpError(
        500,
        `Failed to load manifest for service '${normalizedServiceName}'.`,
      );
    }

    if (serviceRows.length === 0) {
      throw new HttpError(
        404,
        `Manifest not found for service '${normalizedServiceName}'.`,
      );
    }

    let rows: Array<{
      serviceName: string;
      name: string;
      description: string;
      enabled: boolean;
      inputSchema: ToolDefinitionResponse["inputSchema"];
      outputSchema: ToolDefinitionResponse["outputSchema"];
    }>;
    try {
      rows = await db
        .select({
          serviceName: tools.serviceName,
          name: tools.name,
          description: tools.description,
          enabled: tools.enabled,
          inputSchema: tools.inputSchema,
          outputSchema: tools.outputSchema,
        })
        .from(tools)
        .where(eq(tools.serviceName, normalizedServiceName))
        .orderBy(asc(tools.name));
    } catch {
      throw new HttpError(
        500,
        `Failed to load tools for service '${normalizedServiceName}'.`,
      );
    }

    const serviceEnabled = serviceRows[0].enabled;

    const loweredQuery = normalizeOptionalQuery(query);

    const filtered =
      loweredQuery === undefined
        ? rows
        : rows.filter(
            (row) =>
              row.name.toLowerCase().includes(loweredQuery) ||
              row.description.toLowerCase().includes(loweredQuery),
          );

    return filtered.map((row) => ({
      name: row.name,
      description: row.description,
      enabled: serviceEnabled && row.enabled,
      inputSchema: row.inputSchema,
      outputSchema: row.outputSchema,
    }));
  }

  async createService(
    source: ServiceInstallRequest,
  ): Promise<{ name: string; type: ServiceType }> {
    const normalizedType = normalizeServiceType(source.type);
    const normalizedSource = normalizeDefinitionFileUrl(source.source);
    const definitionContent =
      await this.downloadRegistryDefinition(normalizedSource);
    const hash = computeContentHash(definitionContent);
    const parsedManifest = await parseRegisteredManifest(
      this.adapter,
      definitionContent,
    );
    const normalizedServiceName = normalizeServiceName(parsedManifest.name);

    try {
      await db.transaction(async (tx) => {
        await tx.insert(manifests).values({
          id: normalizedServiceName,
          type: normalizedType,
          source: normalizedSource,
          description: parsedManifest.description,
          hash,
          enabled: parsedManifest.enabled,
          metadata: parsedManifest.metadata,
        });

        if (parsedManifest.tools.length > 0) {
          await tx.insert(tools).values(
            parsedManifest.tools.map((tool) => ({
              serviceName: normalizedServiceName,
              name: tool.name,
              description: tool.description,
              enabled: tool.enabled,
              metadata: tool.metadata,
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema,
            })),
          );
        }
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new HttpError(
          409,
          `Manifest already exists for service '${normalizedServiceName}'.`,
        );
      }

      throw new HttpError(
        500,
        `Failed to create manifest for service '${normalizedServiceName}'.`,
      );
    }

    return {
      name: normalizedServiceName,
      type: normalizedType,
    };
  }

  async updateService(serviceName: string): Promise<boolean> {
    const normalizedServiceName = normalizeServiceName(serviceName);

    let existingManifestRow: {
      id: string;
      type: ServiceType;
      source: string;
      hash: string;
    } | null = null;

    try {
      const rows = await db
        .select({
          id: manifests.id,
          type: manifests.type,
          source: manifests.source,
          hash: manifests.hash,
        })
        .from(manifests)
        .where(eq(manifests.id, normalizedServiceName))
        .limit(1);

      existingManifestRow = rows[0] ?? null;
    } catch {
      throw new HttpError(
        500,
        `Failed to load manifest for service '${normalizedServiceName}'.`,
      );
    }

    if (!existingManifestRow) {
      throw new HttpError(
        404,
        `Manifest not found for service '${normalizedServiceName}'.`,
      );
    }

    const storedSource = normalizeOptionalSource(existingManifestRow.source);
    if (!storedSource) {
      throw new HttpError(
        409,
        `Service '${normalizedServiceName}' has no stored install source and cannot be updated automatically.`,
      );
    }

    const definitionContent =
      await this.downloadRegistryDefinition(storedSource);
    const hash = computeContentHash(definitionContent);

    if (existingManifestRow.hash === hash) {
      return false;
    }

    const parsedManifest = await parseRegisteredManifest(
      this.adapter,
      definitionContent,
      normalizedServiceName,
    );

    try {
      await db.transaction(async (tx) => {
        await tx
          .update(manifests)
          .set({
            type: normalizeServiceType(existingManifestRow.type),
            description: parsedManifest.description,
            hash,
            enabled: parsedManifest.enabled,
            source: storedSource,
            metadata: parsedManifest.metadata,
          })
          .where(eq(manifests.id, normalizedServiceName));

        await tx
          .delete(tools)
          .where(eq(tools.serviceName, normalizedServiceName));

        if (parsedManifest.tools.length > 0) {
          await tx.insert(tools).values(
            parsedManifest.tools.map((tool) => ({
              serviceName: normalizedServiceName,
              name: tool.name,
              description: tool.description,
              enabled: tool.enabled,
              metadata: tool.metadata,
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema,
            })),
          );
        }
      });
    } catch {
      throw new HttpError(
        500,
        `Failed to update manifest for service '${normalizedServiceName}'.`,
      );
    }

    return true;
  }

  private async downloadRegistryDefinition(fileUrl: string): Promise<string> {
    const normalizedFileUrl = normalizeDefinitionFileUrl(fileUrl);
    assertRegistryAddressAllowed(normalizedFileUrl);

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, DEFINITION_DOWNLOAD_TIMEOUT_MS);

    let response: Response;
    try {
      response = await this.fetchImpl(normalizedFileUrl, {
        method: "GET",
        headers: {
          accept: "application/json, text/plain, application/octet-stream",
        },
        signal: abortController.signal,
      });
    } catch {
      clearTimeout(timeoutHandle);
      throw new HttpError(
        502,
        `Failed to download definition file from '${normalizedFileUrl}'.`,
      );
    }

    clearTimeout(timeoutHandle);

    if (abortController.signal.aborted) {
      throw new HttpError(
        502,
        `Timed out downloading definition file from '${normalizedFileUrl}'.`,
      );
    }

    assertRegistryAddressAllowed(response.url || normalizedFileUrl);

    if (!response.ok) {
      throw new HttpError(
        502,
        `Failed to download definition file from '${normalizedFileUrl}' with status ${response.status}.`,
      );
    }

    let content: string;
    try {
      content = await readBodyAsUtf8WithLimit(
        response,
        MAX_DEFINITION_DOWNLOAD_BYTES,
      );
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      if (abortController.signal.aborted) {
        throw new HttpError(
          502,
          `Timed out reading definition file downloaded from '${normalizedFileUrl}'.`,
        );
      }

      throw new HttpError(
        502,
        `Failed to read definition file downloaded from '${normalizedFileUrl}'.`,
      );
    }

    if (!content.trim()) {
      throw new HttpError(400, "Field 'content' must not be empty.");
    }

    return content;
  }
  async deleteService(serviceName: string): Promise<void> {
    const normalizedServiceName = normalizeServiceName(serviceName);

    let deletedRows: Array<{ id: string }>;
    try {
      deletedRows = await db
        .delete(manifests)
        .where(eq(manifests.id, normalizedServiceName))
        .returning({ id: manifests.id });
    } catch {
      throw new HttpError(
        500,
        `Failed to delete manifest for service '${normalizedServiceName}'.`,
      );
    }

    if (deletedRows.length === 0) {
      throw new HttpError(
        404,
        `Manifest not found for service '${normalizedServiceName}'.`,
      );
    }
  }

  async discoverTools(
    query: string,
    limit?: number,
    enabled: boolean | null = true,
  ): Promise<ToolDefinitionResponse[]> {
    const normalizedQuery = normalizeDiscoverQuery(query);
    const normalizedLimit = normalizeDiscoverLimit(limit);
    const normalizedEnabled = normalizeDiscoverEnabled(enabled);

    let rows: Array<
      Omit<ToolDefinitionResponse, "enabled"> & {
        toolEnabled: boolean;
        serviceEnabled: boolean;
      }
    >;
    try {
      rows = await db
        .select({
          serviceName: tools.serviceName,
          name: tools.name,
          description: tools.description,
          toolEnabled: tools.enabled,
          serviceEnabled: manifests.enabled,
          serviceDescription: manifests.description,
          inputSchema: tools.inputSchema,
          outputSchema: tools.outputSchema,
        })
        .from(tools)
        .innerJoin(manifests, eq(tools.serviceName, manifests.id))
        .orderBy(asc(tools.serviceName), asc(tools.name));
    } catch {
      throw new HttpError(500, "Failed to discover tools.");
    }

    const mappedRows: ToolDefinitionResponse[] = rows.map((row) => ({
      serviceName: row.serviceName,
      name: row.name,
      description: row.description,
      enabled: row.serviceEnabled && row.toolEnabled,
      serviceDescription: row.serviceDescription,
      inputSchema: row.inputSchema,
      outputSchema: row.outputSchema,
    }));

    const enabledFiltered =
      normalizedEnabled === null
        ? mappedRows
        : mappedRows.filter((row) => row.enabled === normalizedEnabled);

    if (normalizedQuery.length === 0) {
      return applyDiscoverLimit(enabledFiltered, normalizedLimit);
    }

    const loweredQuery = normalizedQuery.toLowerCase();

    const filtered = enabledFiltered.filter(
      (row) =>
        row.name.toLowerCase().includes(loweredQuery) ||
        row.description.toLowerCase().includes(loweredQuery) ||
        row.serviceName.toLowerCase().includes(loweredQuery) ||
        row.serviceDescription.toLowerCase().includes(loweredQuery),
    );

    return applyDiscoverLimit(filtered, normalizedLimit);
  }

  async discoverServices(
    query: string,
    limit?: number,
    enabled: boolean | null = true,
  ): Promise<ServiceManifestResponse[]> {
    const normalizedQuery = normalizeDiscoverQuery(query);
    const normalizedLimit = normalizeDiscoverLimit(limit);
    const normalizedEnabled = normalizeDiscoverEnabled(enabled);
    const services = await this.listServices();
    const enabledFiltered =
      normalizedEnabled === null
        ? services
        : services.filter((service) => service.enabled === normalizedEnabled);

    if (normalizedQuery.length === 0) {
      return applyDiscoverLimit(enabledFiltered, normalizedLimit);
    }

    const loweredQuery = normalizedQuery.toLowerCase();

    const filtered = enabledFiltered.filter((service) =>
      service.name.toLowerCase().includes(loweredQuery),
    );

    return applyDiscoverLimit(filtered, normalizedLimit);
  }

  async getTool(
    serviceName: string,
    toolName: string,
  ): Promise<ResolvedToolInvocation> {
    const normalizedServiceName = normalizeServiceName(serviceName);
    const normalizedToolName = normalizeToolName(toolName);

    let serviceManifest: {
      metadata: ManifestMetadata;
      enabled: boolean;
    } | null;
    try {
      serviceManifest = await this.loadServiceMetadata(normalizedServiceName);
    } catch {
      throw new HttpError(
        500,
        `Failed to load manifest for service '${normalizedServiceName}'.`,
      );
    }

    if (!serviceManifest) {
      throw new HttpError(
        404,
        `Manifest not found for service '${normalizedServiceName}'.`,
      );
    }

    let tool: ToolDefinition | null;
    try {
      tool = await this.loadToolByName(
        normalizedServiceName,
        normalizedToolName,
      );
    } catch {
      throw new HttpError(
        500,
        `Failed to load tool '${normalizedToolName}' for service '${normalizedServiceName}'.`,
      );
    }

    if (!tool) {
      throw new HttpError(
        404,
        `Tool '${normalizedToolName}' not found in manifest for service '${normalizedServiceName}'.`,
      );
    }

    return {
      tool,
      serviceMetadata: serviceManifest.metadata,
      serviceEnabled: serviceManifest.enabled,
    };
  }

  async setServiceEnabled(
    serviceName: string,
    enabled: boolean,
  ): Promise<void> {
    const normalizedServiceName = normalizeServiceName(serviceName);
    const normalizedEnabled = normalizeEnabled(enabled);

    let updatedRows: Array<{ id: string }>;
    try {
      updatedRows = await db
        .update(manifests)
        .set({ enabled: normalizedEnabled })
        .where(eq(manifests.id, normalizedServiceName))
        .returning({ id: manifests.id });
    } catch {
      throw new HttpError(
        500,
        `Failed to update enabled status for service '${normalizedServiceName}'.`,
      );
    }

    if (updatedRows.length === 0) {
      throw new HttpError(
        404,
        `Manifest not found for service '${normalizedServiceName}'.`,
      );
    }
  }

  async setToolEnabled(
    serviceName: string,
    toolName: string,
    enabled: boolean,
  ): Promise<void> {
    const normalizedServiceName = normalizeServiceName(serviceName);
    const normalizedToolName = normalizeToolName(toolName);
    const normalizedEnabled = normalizeEnabled(enabled);

    let updatedRows: Array<{ serviceName: string; name: string }>;
    try {
      updatedRows = await db
        .update(tools)
        .set({ enabled: normalizedEnabled })
        .where(
          and(
            eq(tools.serviceName, normalizedServiceName),
            eq(tools.name, normalizedToolName),
          ),
        )
        .returning({ serviceName: tools.serviceName, name: tools.name });
    } catch {
      throw new HttpError(
        500,
        `Failed to update enabled status for tool '${normalizedToolName}' in service '${normalizedServiceName}'.`,
      );
    }

    if (updatedRows.length === 0) {
      throw new HttpError(
        404,
        `Tool '${normalizedToolName}' not found in manifest for service '${normalizedServiceName}'.`,
      );
    }
  }
}

async function parseRegisteredManifest(
  adapter: AdapterModule,
  definitionContent: string,
  expectedServiceName?: string,
): Promise<ServiceManifest> {
  try {
    const parsedManifest = await adapter.register(definitionContent);

    if (
      expectedServiceName !== undefined &&
      parsedManifest.name !== expectedServiceName
    ) {
      throw new HttpError(
        400,
        `Manifest name '${parsedManifest.name}' must match service name '${expectedServiceName}'.`,
      );
    }

    return parsedManifest satisfies ServiceManifest;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    throw new HttpError(
      400,
      error instanceof Error ? error.message : "Invalid definition content.",
    );
  }
}

export function isUniqueConstraintViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeDatabaseError = error as {
    message?: unknown;
    code?: unknown;
  };

  const code =
    typeof maybeDatabaseError.code === "string" ? maybeDatabaseError.code : "";
  if (
    code === "23505" ||
    /^SQLITE_CONSTRAINT_(UNIQUE|PRIMARYKEY)$/i.test(code)
  ) {
    return true;
  }

  const message =
    typeof maybeDatabaseError.message === "string"
      ? maybeDatabaseError.message
      : "";

  return [
    /UNIQUE constraint failed:/i,
    /unique constraint failed/i,
    /duplicate key value/i,
    /\bduplicate key\b/i,
    /violates unique constraint/i,
  ].some((pattern) => pattern.test(message));
}

function normalizeServiceName(serviceName: string): string {
  const normalized = serviceName.trim();

  if (!normalized) {
    throw new HttpError(400, "Service name must not be empty.");
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) {
    throw new HttpError(
      400,
      "Service name may only contain letters, numbers, dot, underscore, and hyphen.",
    );
  }

  return normalized;
}

function normalizeOptionalQuery(query: string | undefined): string | undefined {
  const normalized = query?.trim().toLowerCase();

  if (!normalized) {
    return undefined;
  }

  return normalized;
}

function normalizeToolName(toolName: string): string {
  const normalized = toolName.trim();

  if (!normalized) {
    throw new HttpError(400, "Tool name must not be empty.");
  }

  return normalized;
}

function normalizeDiscoverQuery(query: string): string {
  if (typeof query !== "string") {
    throw new HttpError(400, "Field 'query' must be a string.");
  }

  return query.trim();
}

function normalizeDiscoverLimit(limit: unknown): number | undefined {
  if (limit === undefined) {
    return undefined;
  }

  if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
    throw new HttpError(400, "Field 'limit' must be a positive integer.");
  }

  return limit;
}

function normalizeDiscoverEnabled(enabled: unknown): boolean | null {
  if (enabled === undefined) {
    return true;
  }

  if (enabled === null || typeof enabled === "boolean") {
    return enabled;
  }

  throw new HttpError(400, "Field 'enabled' must be a boolean or null.");
}

function applyDiscoverLimit<T>(items: T[], limit: number | undefined): T[] {
  if (limit === undefined) {
    return items;
  }

  return items.slice(0, limit);
}

function normalizeServiceType(type: string): ServiceType {
  const normalized = type.trim();

  if (!normalized) {
    throw new HttpError(400, "Field 'type' must not be empty.");
  }

  return normalized;
}

function normalizeOptionalSource(source: string): string | null {
  if (typeof source !== "string") {
    return null;
  }

  const normalized = source.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeDefinitionFileUrl(fileUrl: string): string {
  if (typeof fileUrl !== "string") {
    throw new HttpError(400, "Field 'metadata.file_url' must be a string.");
  }

  const normalized = fileUrl.trim();

  if (!normalized) {
    throw new HttpError(400, "Field 'metadata.file_url' must not be empty.");
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new HttpError(400, "Field 'metadata.file_url' must be a valid URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(
      400,
      "Field 'metadata.file_url' must use the http or https protocol.",
    );
  }

  return parsed.toString();
}

function assertRegistryAddressAllowed(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(502, "Registry download redirected to an invalid URL.");
  }

  const hostname = parsed.hostname.trim().toLowerCase();
  const normalizedHost =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  if (normalizedHost === "localhost" || normalizedHost.endsWith(".localhost")) {
    throw new HttpError(
      502,
      "Registry URL resolves to a disallowed local address.",
    );
  }

  if (!isIP(normalizedHost)) {
    return;
  }

  if (isPrivateOrLocalIp(normalizedHost)) {
    throw new HttpError(
      502,
      "Registry URL resolves to a disallowed local address.",
    );
  }
}

function isPrivateOrLocalIp(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const octets = address
      .split(".")
      .map((segment) => Number.parseInt(segment, 10));
    if (
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet))
    ) {
      return true;
    }

    const [a, b] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.") ||
      /^::ffff:172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)
    );
  }

  return true;
}

async function readBodyAsUtf8WithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const declaredContentLength = Number.parseInt(contentLengthHeader, 10);
    if (
      Number.isFinite(declaredContentLength) &&
      declaredContentLength > maxBytes
    ) {
      throw new HttpError(
        413,
        `Definition file exceeds maximum allowed size of ${maxBytes} bytes.`,
      );
    }
  }

  if (!response.body) {
    throw new HttpError(
      502,
      "Downloaded definition file did not include a response body.",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const chunks: string[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new HttpError(
            413,
            `Definition file exceeds maximum allowed size of ${maxBytes} bytes.`,
          );
        }

        chunks.push(decoder.decode(value, { stream: true }));
      }
    }

    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

async function loadServiceMetadataByServiceName(
  serviceName: string,
): Promise<{ metadata: ManifestMetadata; enabled: boolean } | null> {
  const rows = await db
    .select({ metadata: manifests.metadata, enabled: manifests.enabled })
    .from(manifests)
    .where(eq(manifests.id, serviceName))
    .limit(1);

  if (rows.length === 0) {
    return null;
  }

  const metadata = rows[0].metadata;
  if (!isRecord(metadata)) {
    throw new HttpError(
      500,
      `Stored manifest for service '${serviceName}' has invalid metadata.`,
    );
  }

  return {
    metadata,
    enabled: rows[0].enabled,
  };
}

async function loadToolByServiceAndToolName(
  serviceName: string,
  toolName: string,
): Promise<ToolDefinition | null> {
  const rows = await db
    .select({
      name: tools.name,
      description: tools.description,
      enabled: tools.enabled,
      inputSchema: tools.inputSchema,
      outputSchema: tools.outputSchema,
      metadata: tools.metadata,
    })
    .from(tools)
    .where(and(eq(tools.serviceName, serviceName), eq(tools.name, toolName)))
    .limit(1);

  if (rows.length === 0) {
    return null;
  }

  const tool = rows[0];
  if (!isToolDefinition(tool)) {
    throw new HttpError(
      500,
      `Stored tool '${toolName}' for service '${serviceName}' is invalid.`,
    );
  }

  return tool;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isToolDefinition(value: unknown): value is ToolDefinition {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    typeof value.description === "string" &&
    typeof value.enabled === "boolean" &&
    isRecord(value.inputSchema) &&
    isRecord(value.outputSchema) &&
    isRecord(value.metadata)
  );
}

function normalizeEnabled(enabled: unknown): boolean {
  if (typeof enabled !== "boolean") {
    throw new HttpError(400, "Field 'enabled' must be a boolean.");
  }

  return enabled;
}
