import dns from "node:dns/promises";

import type {
  JSONSchema,
  ServiceDefinition,
  ServiceState,
  ToolDocsInput,
} from "@mci/sdk";
import { and, asc, eq, getTableColumns, like, or } from "drizzle-orm";
import jsonpatch from "fast-json-patch";

import ipaddr from "ipaddr.js";
import { z } from "zod";

import { db } from "@/db/client";
import {
  serviceConfigurations,
  serviceSecrets,
  services,
  tools,
} from "@/db/schema";
import { logger } from "@/logger";
import { HttpError } from "@/models/error.model";
import type { GenerateDefinitionInput } from "@/models/modules.model";
import type {
  GetServiceDefinitionResult,
  GetToolInput,
  GetToolsResult,
  InstallServiceDefinitionInput,
  ListServiceDefinitionResult,
  ListServicesInput,
  ListToolsInput,
  ListToolsResult,
  PatchInput,
  SetServiceEnabledInput,
  SetToolEnablesInput,
} from "@/models/services.model";
import { computeContentHash } from "@/utils/hash.util";
import { decryptSecrets, encryptSecrets } from "@/utils/secrets.util";
import {
  applyJsonSchemaDefaults,
  validateJsonSchema,
} from "@/utils/validation.util";

const DEFINITION_DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_DEFINITION_DOWNLOAD_BYTES = 2_048_576;
const MAX_DEFINITION_DOWNLOAD_REDIRECTS = 5;
const IDENTIFIER_SCHEMA = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/);

export interface AdapterController {
  generateDefinition(
    input: GenerateDefinitionInput,
  ): Promise<ServiceDefinition>;
  hydrateService(adapterId: string, state: ServiceState): Promise<void>;
  dehydrateService(adapterId: string, serviceId: string): Promise<void>;
  generateToolDocs(input: ToolDocsInput): Promise<string>;
}

const encryptedSecretsSchema = z.object({
  alg: z.literal("aes-256-gcm"),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

export class ServicesService {
  constructor(private readonly controller: AdapterController) {}

  async listServices(
    input?: ListServicesInput,
  ): Promise<ListServiceDefinitionResult[]> {
    const normalizedQuery = input?.query?.trim();

    try {
      const { configSchema, secretsSchema, adapterDomain, ...serviceColumns } =
        getTableColumns(services);

      const query = db
        .select(serviceColumns)
        .from(services)
        .where(
          and(
            input?.enabled !== undefined
              ? eq(services.enabled, input.enabled)
              : undefined,
            normalizedQuery
              ? or(
                  like(services.id, `%${normalizedQuery}%`),
                  like(services.name, `%${normalizedQuery}%`),
                  like(services.description, `%${normalizedQuery}%`),
                )
              : undefined,
          ),
        )
        .orderBy(asc(services.id));

      return await (input?.limit !== undefined
        ? query.limit(Number(input.limit))
        : query);
    } catch {
      throw new HttpError(500, "Failed to list services.");
    }
  }

  async getService(id: string): Promise<GetServiceDefinitionResult> {
    const { adapterDomain, ...serviceColumns } = getTableColumns(services);
    const [row] = await db
      .select(serviceColumns)
      .from(services)
      .where(eq(services.id, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, `Failed to load service '${id}'.`);
      });

    if (!row) throw new HttpError(404, `Service '${id}' not found.`);
    return row;
  }

  async listTools(input: ListToolsInput): Promise<ListToolsResult[]> {
    let serviceEnabled: boolean | undefined;

    if (input.serviceId) {
      const [service] = await db
        .select({ enabled: services.enabled })
        .from(services)
        .where(eq(services.id, input.serviceId))
        .limit(1)
        .catch(() => {
          throw new HttpError(
            500,
            `Failed to load service '${input.serviceId}'.`,
          );
        });

      if (!service)
        throw new HttpError(404, `Service '${input.serviceId}' not found.`);
      serviceEnabled = service.enabled;
    }

    const normalizedQuery = input.query?.trim();

    const query = db
      .select({
        serviceId: tools.serviceId,
        id: tools.id,
        name: tools.name,
        description: tools.description,
        enabled: tools.enabled,
      })
      .from(tools)
      .where(
        and(
          input.serviceId ? eq(tools.serviceId, input.serviceId) : undefined,
          input.enabled !== undefined
            ? eq(tools.enabled, input.enabled)
            : undefined,
          normalizedQuery
            ? or(
                like(tools.name, `%${normalizedQuery}%`),
                like(tools.description, `%${normalizedQuery}%`),
              )
            : undefined,
        ),
      )
      .orderBy(asc(tools.name));

    const rows = await (input.limit !== undefined
      ? query.limit(input.limit)
      : query
    ).catch(() => {
      throw new HttpError(500, `Failed to load tools.`);
    });

    return rows.map((row) => ({
      ...row,
      effectivelyEnabled: (serviceEnabled ?? true) && row.enabled,
    }));
  }

  async getTool(input: GetToolInput): Promise<GetToolsResult> {
    const { serviceId, adapterDomain, ...toolColumns } = getTableColumns(tools);
    const [tool] = await db
      .select({
        ...toolColumns,
        serviceEnabled: services.enabled,
      })
      .from(tools)
      .innerJoin(services, eq(tools.serviceId, services.id))
      .where(
        and(eq(tools.serviceId, input.serviceId), eq(tools.id, input.toolId)),
      )
      .limit(1)
      .catch(() => {
        throw new HttpError(
          500,
          `Failed to load tool '${input.toolId}' for service '${input.serviceId}'.`,
        );
      });

    if (!tool)
      throw new HttpError(
        404,
        `Tool '${input.toolId}' not found for service '${input.serviceId}'.`,
      );

    return {
      ...tool,
      effectivelyEnabled: tool.enabled && tool.serviceEnabled,
    };
  }

  async getToolDocs(input: GetToolInput): Promise<string> {
    const [tool] = await db
      .select({
        description: tools.description,
        inputSchema: tools.inputSchema,
        outputSchema: tools.outputSchema,
      })
      .from(tools)
      .where(
        and(eq(tools.serviceId, input.serviceId), eq(tools.id, input.toolId)),
      )
      .limit(1)
      .catch(() => {
        throw new HttpError(
          500,
          `Failed to load tool '${input.toolId}' for service '${input.serviceId}'.`,
        );
      });

    if (!tool)
      throw new HttpError(
        404,
        `Tool '${input.toolId}' not found for service '${input.serviceId}'.`,
      );

    const docsInput: ToolDocsInput = {
      serviceId: input.serviceId,
      toolId: input.toolId,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    };

    return this.controller.generateToolDocs(docsInput);
  }

  async createService(input: InstallServiceDefinitionInput): Promise<void> {
    if (!IDENTIFIER_SCHEMA.safeParse(input.id).success) {
      throw new HttpError(
        400,
        `Service id '${input.id}' must be a valid TypeScript identifier.`,
      );
    }

    const definitionContent = await this.downloadDefinition(input.source);
    const hash = computeContentHash(definitionContent);
    const generatedDefinition = await this.controller.generateDefinition({
      definition: definitionContent,
      adapter: input.adapter,
    });

    for (const tool of generatedDefinition.tools) {
      if (!IDENTIFIER_SCHEMA.safeParse(tool.id).success) {
        throw new HttpError(
          400,
          `Tool id '${tool.id}' must be a valid TypeScript identifier.`,
        );
      }
    }

    try {
      await db.transaction(async (tx) => {
        await tx.insert(services).values({
          ...generatedDefinition,
          id: input.id,
          hash,
          source: input.source,
          adapter: input.adapter,
          enabled: false,
        });
        await tx.insert(tools).values(
          generatedDefinition.tools.map((tool) => ({
            ...tool,
            serviceId: input.id,
            enabled: true,
          })),
        );
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new HttpError(409, `Service '${input.id}' already exists.`);
      }
      throw new HttpError(500, `Failed to create service '${input.id}'.`);
    }
  }

  async updateService(id: string): Promise<void> {
    const [service] = await db
      .select({ adapter: services.adapter, source: services.source })
      .from(services)
      .where(eq(services.id, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, `Failed to load service '${id}'.`);
      });

    if (!service) throw new HttpError(404, `Service '${id}' not found.`);
    if (!service.source)
      throw new HttpError(
        409,
        `Service '${id}' has no stored install source and cannot be updated automatically.`,
      );

    const definitionContent = await this.downloadDefinition(service.source);
    const hash = computeContentHash(definitionContent);
    const parsedDefinition = await this.controller.generateDefinition({
      definition: definitionContent,
      adapter: service.adapter,
    });

    for (const tool of parsedDefinition.tools) {
      if (!IDENTIFIER_SCHEMA.safeParse(tool.id).success) {
        throw new HttpError(
          400,
          `Tool id '${tool.id}' must be a valid TypeScript identifier.`,
        );
      }
    }

    try {
      await db.transaction(async (tx) => {
        const existingTools = await tx
          .select({ name: tools.name, enabled: tools.enabled })
          .from(tools)
          .where(eq(tools.serviceId, id));

        const enabledMap = new Map(
          existingTools.map((t) => [t.name, t.enabled]),
        );

        await tx
          .update(services)
          .set({ ...parsedDefinition, hash, enabled: false })
          .where(eq(services.id, id));

        await tx.delete(tools).where(eq(tools.serviceId, id));

        if (parsedDefinition.tools.length) {
          await tx.insert(tools).values(
            parsedDefinition.tools.map((tool) => ({
              ...tool,
              serviceId: id,
              enabled: enabledMap.get(tool.name) ?? false,
            })),
          );
        }
      });
    } catch {
      throw new HttpError(500, `Failed to update service '${id}'.`);
    }

    try {
      await this.controller.dehydrateService(service.adapter, id);
    } catch (err) {
      logger.warn(
        { err, adapterId: service.adapter, serviceId: id },
        "Failed to dehydrate service on update",
      );
    }
  }

  async deleteService(id: string): Promise<void> {
    const [deleted] = await db
      .delete(services)
      .where(eq(services.id, id))
      .returning({ id: services.id, adapter: services.adapter })
      .catch(() => {
        throw new HttpError(500, `Failed to delete service '${id}'.`);
      });

    if (!deleted) throw new HttpError(404, `Service '${id}' not found.`);

    try {
      await this.controller.dehydrateService(deleted.adapter, id);
    } catch (err) {
      logger.warn(
        { err, adapterId: deleted.adapter, serviceId: id },
        "Failed to dehydrate service on delete",
      );
    }
  }

  async setServiceEnabled(input: SetServiceEnabledInput): Promise<void> {
    if (input.enabled) {
      const [config, schema] = await Promise.all([
        this.getServiceConfig(input.id),
        this.getServiceConfigSchema(input.id),
      ]);
      if (!isNullOnlySchema(schema)) {
        applyJsonSchemaDefaults(
          schema,
          config,
          `Invalid configuration for service '${input.id}'.`,
        );
      }

      const [secrets, secretsSchema] = await Promise.all([
        this.loadServiceSecrets(input.id),
        this.getServiceSecretsSchema(input.id),
      ]);
      if (!isNullOnlySchema(secretsSchema)) {
        applyJsonSchemaDefaults(
          secretsSchema,
          secrets,
          `Invalid secrets for service '${input.id}'.`,
        );
      }
    }

    const [updated] = await db
      .update(services)
      .set({ enabled: input.enabled })
      .where(eq(services.id, input.id))
      .returning({ id: services.id, adapter: services.adapter })
      .catch((err) => {
        if (err instanceof HttpError) throw err;
        throw new HttpError(
          500,
          `Failed to update enabled status for service '${input.id}'.`,
        );
      });

    if (!updated) throw new HttpError(404, `Service '${input.id}' not found.`);

    if (input.enabled) {
      try {
        const state = await this.buildServiceState(input.id);
        await this.controller.hydrateService(updated.adapter, state);
      } catch (err) {
        await db
          .update(services)
          .set({ enabled: false })
          .where(eq(services.id, input.id))
          .catch((rollbackErr) => {
            logger.error(
              { err: rollbackErr, serviceId: input.id },
              "Failed to roll back enabled flag after hydrate failure",
            );
          });

        if (err instanceof HttpError) throw err;
        throw new HttpError(
          502,
          `Failed to hydrate service '${input.id}' on adapter '${updated.adapter}'.`,
        );
      }
    } else {
      try {
        await this.controller.dehydrateService(updated.adapter, input.id);
      } catch (err) {
        logger.warn(
          { err, adapterId: updated.adapter, serviceId: input.id },
          "Failed to dehydrate service on disable",
        );
      }
    }
  }

  async setToolEnabled(input: SetToolEnablesInput): Promise<void> {
    const [updated] = await db
      .update(tools)
      .set({ enabled: input.enabled })
      .where(
        and(eq(tools.serviceId, input.serviceId), eq(tools.id, input.toolId)),
      )
      .returning({ id: tools.id })
      .catch(() => {
        throw new HttpError(
          500,
          `Failed to update enabled status for tool '${input.toolId}' in service '${input.serviceId}'.`,
        );
      });

    if (!updated)
      throw new HttpError(
        404,
        `Tool '${input.toolId}' not found in service '${input.serviceId}'.`,
      );
  }

  async getServiceConfig(id: string): Promise<Record<string, unknown>> {
    const [row] = await db
      .select({ payload: serviceConfigurations.payload })
      .from(serviceConfigurations)
      .where(eq(serviceConfigurations.serviceId, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, "Failed to load configuration.");
      });

    const payload = row?.payload;
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  }

  async getServiceConfigSchema(id: string): Promise<JSONSchema> {
    const [row] = await db
      .select({ configSchema: services.configSchema })
      .from(services)
      .where(eq(services.id, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, "Failed to load configuration schema.");
      });

    if (!row) throw new HttpError(404, `Service '${id}' not found.`);
    return row.configSchema;
  }

  async patchServiceConfig(input: PatchInput): Promise<void> {
    const [current, schema] = await Promise.all([
      this.getServiceConfig(input.id),
      this.getServiceConfigSchema(input.id),
    ]);

    let updated: Record<string, unknown>;
    try {
      const result = jsonpatch.applyPatch(
        current,
        input.patch,
        true,
        false,
      ).newDocument;
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new HttpError(
          400,
          "Configuration payload must be a JSON object.",
        );
      }
      updated = result as Record<string, unknown>;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(
        400,
        err instanceof Error ? err.message : "Invalid JSON Patch payload.",
      );
    }

    const nullOnly = isNullOnlySchema(schema);
    if (!nullOnly) {
      validateJsonSchema(
        schema,
        updated,
        `Invalid configuration for service '${input.id}'.`,
      );
    }

    const payload = nullOnly
      ? updated
      : applyJsonSchemaDefaults(
          schema,
          updated,
          `Invalid configuration for service '${input.id}'.`,
        );

    await db
      .insert(serviceConfigurations)
      .values({ serviceId: input.id, payload, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: serviceConfigurations.serviceId,
        set: { payload, updatedAt: Date.now() },
      })
      .catch(() => {
        throw new HttpError(
          500,
          `Failed to persist configuration for service '${input.id}'.`,
        );
      });

    await this.hydrateIfEnabled(input.id);
  }

  async getServiceSecretsSchema(id: string): Promise<JSONSchema> {
    const [row] = await db
      .select({ secretsSchema: services.secretsSchema })
      .from(services)
      .where(eq(services.id, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, "Failed to load secrets schema.");
      });

    if (!row) throw new HttpError(404, `Service '${id}' not found.`);
    return row.secretsSchema;
  }

  async patchServiceSecrets(input: PatchInput): Promise<void> {
    const [schema, current] = await Promise.all([
      this.getServiceSecretsSchema(input.id),
      this.loadServiceSecrets(input.id),
    ]);

    let updated: Record<string, unknown>;
    try {
      updated = (() => {
        const result = jsonpatch.applyPatch(
          current,
          input.patch,
          true,
          false,
        ).newDocument;
        if (result && typeof result === "object" && !Array.isArray(result)) {
          return result as Record<string, unknown>;
        }
        throw new HttpError(400, "Secrets payload must be a JSON object.");
      })();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(
        400,
        err instanceof Error ? err.message : "Invalid JSON Patch payload.",
      );
    }

    validateJsonSchema(
      schema,
      updated,
      `Invalid secrets for service '${input.id}'.`,
    );

    const payload = isNullOnlySchema(schema)
      ? updated
      : applyJsonSchemaDefaults(
          schema,
          updated,
          `Invalid secrets for service '${input.id}'.`,
        );

    const encrypted = encryptSecrets(payload);

    await db
      .insert(serviceSecrets)
      .values({
        serviceId: input.id,
        payload: encrypted,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: serviceSecrets.serviceId,
        set: { payload: encrypted, updatedAt: Date.now() },
      })
      .catch(() => {
        throw new HttpError(
          500,
          `Failed to persist secrets for service '${input.id}'.`,
        );
      });

    await this.hydrateIfEnabled(input.id);
  }

  async hydrateAdapter(adapterId: string): Promise<void> {
    const rows = await db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.adapter, adapterId), eq(services.enabled, true)))
      .catch((err) => {
        logger.warn(
          { err, adapterId },
          "Failed to load services for adapter activation",
        );
        return [] as { id: string }[];
      });

    await Promise.all(
      rows.map(async (row) => {
        try {
          const state = await this.buildServiceState(row.id);
          await this.controller.hydrateService(adapterId, state);
        } catch (err) {
          logger.warn(
            { err, adapterId, serviceId: row.id },
            "Failed to hydrate service on adapter activation",
          );
        }
      }),
    );
  }

  private async hydrateIfEnabled(id: string): Promise<void> {
    const [row] = await db
      .select({ enabled: services.enabled, adapter: services.adapter })
      .from(services)
      .where(eq(services.id, id))
      .limit(1)
      .catch(() => [] as { enabled: boolean; adapter: string }[]);

    if (!row?.enabled) return;

    const state = await this.buildServiceState(id);
    await this.controller.hydrateService(row.adapter, state);
  }

  private async buildServiceState(id: string): Promise<ServiceState> {
    const [serviceRow] = await db
      .select({ adapterDomain: services.adapterDomain })
      .from(services)
      .where(eq(services.id, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, `Failed to load service '${id}'.`);
      });

    if (!serviceRow) throw new HttpError(404, `Service '${id}' not found.`);

    const [toolRows, config, secrets] = await Promise.all([
      db
        .select({ name: tools.name, adapterDomain: tools.adapterDomain })
        .from(tools)
        .where(eq(tools.serviceId, id))
        .catch(() => {
          throw new HttpError(500, `Failed to load tools for service '${id}'.`);
        }),
      this.getServiceConfig(id),
      this.loadServiceSecrets(id),
    ]);

    return {
      id,
      adapterDomain: serviceRow.adapterDomain,
      tools: Object.fromEntries(
        toolRows.map((t) => [t.name, { adapterDomain: t.adapterDomain }]),
      ),
      config,
      secrets,
    };
  }

  private async loadServiceSecrets(
    id: string,
  ): Promise<Record<string, unknown>> {
    const [row] = await db
      .select({ payload: serviceSecrets.payload })
      .from(serviceSecrets)
      .where(eq(serviceSecrets.serviceId, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, `Failed to load secrets for service '${id}'.`);
      });

    if (!row?.payload) return {};

    const parsed = encryptedSecretsSchema.safeParse(row.payload);
    if (!parsed.success)
      throw new HttpError(500, "Stored secrets payload is malformed.");

    return decryptSecrets(parsed.data);
  }

  private async downloadDefinition(fileUrl: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DEFINITION_DOWNLOAD_TIMEOUT_MS,
    );

    let response: Response;
    try {
      let currentUrl = fileUrl;
      for (let hop = 0; ; hop++) {
        await assertRegistryAddressAllowed(currentUrl);

        let hopResponse: Response;
        try {
          hopResponse = await fetch(currentUrl, {
            method: "GET",
            headers: {
              accept: "application/json, text/plain, application/octet-stream",
            },
            signal: controller.signal,
            redirect: "manual",
          });
        } catch {
          if (controller.signal.aborted)
            throw new HttpError(502, "Definition download timed out.");
          throw new HttpError(502, "Failed to download definition file.");
        }

        const isRedirect =
          hopResponse.status >= 300 &&
          hopResponse.status < 400 &&
          hopResponse.status !== 304;

        if (!isRedirect) {
          response = hopResponse;
          break;
        }

        if (hop >= MAX_DEFINITION_DOWNLOAD_REDIRECTS) {
          throw new HttpError(
            502,
            "Definition download exceeded maximum redirect count.",
          );
        }

        const location = hopResponse.headers.get("location");
        if (!location) {
          throw new HttpError(
            502,
            "Definition download redirect was missing a Location header.",
          );
        }

        let nextUrl: string;
        try {
          nextUrl = new URL(location, currentUrl).toString();
        } catch {
          throw new HttpError(
            502,
            "Definition download redirected to an invalid URL.",
          );
        }

        await hopResponse.body?.cancel().catch(() => {});
        currentUrl = nextUrl;
      }
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new HttpError(
        502,
        `Failed to download definition file with status ${response.status}.`,
      );
    }

    const sizeError = `Definition file exceeds maximum allowed size of ${MAX_DEFINITION_DOWNLOAD_BYTES} bytes.`;
    const contentLength = response.headers.get("content-length");
    if (
      contentLength &&
      Number.isFinite(+contentLength) &&
      +contentLength > MAX_DEFINITION_DOWNLOAD_BYTES
    ) {
      throw new HttpError(413, sizeError);
    }

    if (!response.body) {
      throw new HttpError(
        502,
        "Downloaded definition file did not include a response body.",
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let total = 0;
    let content = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_DEFINITION_DOWNLOAD_BYTES) {
          await reader.cancel();
          throw new HttpError(413, sizeError);
        }
        content += decoder.decode(value, { stream: true });
      }
      content += decoder.decode();
    } finally {
      reader.releaseLock();
    }

    if (!content.trim())
      throw new HttpError(400, "Downloaded definition file was empty.");
    return content;
  }
}

async function assertRegistryAddressAllowed(url: string): Promise<void> {
  if (isPrivateRegistryAllowed()) return;

  let hostname: string;

  try {
    hostname = new URL(url).hostname.trim().toLowerCase();
  } catch {
    throw new HttpError(502, "Registry download redirected to an invalid URL.");
  }

  const normalizedHost =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  const blockedError = new HttpError(
    502,
    "Registry download blocked: address is not publicly routable.",
  );

  if (ipaddr.isValid(normalizedHost)) {
    if (ipaddr.process(normalizedHost).range() !== "unicast") {
      throw blockedError;
    }
    return;
  }

  let resolved: { address: string }[];
  try {
    resolved = await dns.lookup(normalizedHost, { all: true });
  } catch {
    throw new HttpError(502, "Failed to resolve registry hostname.");
  }

  if (resolved.length === 0) throw blockedError;

  for (const { address } of resolved) {
    if (!ipaddr.isValid(address)) throw blockedError;
    if (ipaddr.process(address).range() !== "unicast") throw blockedError;
  }
}

function isPrivateRegistryAllowed(): boolean {
  const v = process.env.MCI_ALLOW_PRIVATE_REGISTRY;
  return v === "1" || v?.toLowerCase() === "true";
}

function isNullOnlySchema(schema: Record<string, unknown>): boolean {
  const t = schema.type;
  return (
    t === "null" || (Array.isArray(t) && t.length === 1 && t[0] === "null")
  );
}

function isUniqueConstraintError(
  err: unknown,
  seen = new Set<unknown>(),
): boolean {
  if (!err || typeof err !== "object" || seen.has(err)) return false;
  seen.add(err);
  const { code, message } = err as { code?: unknown; message?: unknown };
  const c = typeof code === "string" ? code : "";
  const m = typeof message === "string" ? message : "";
  if (
    c === "23505" ||
    /^SQLITE_CONSTRAINT_(UNIQUE|PRIMARYKEY)$/i.test(c) ||
    /UNIQUE constraint failed:|duplicate key value|\bduplicate key\b|violates unique constraint/i.test(
      m,
    )
  ) {
    return true;
  }
  return isUniqueConstraintError((err as { cause?: unknown }).cause, seen);
}
