import type { Request, Response } from "express";
import type { Operation } from "fast-json-patch";
import { z } from "zod";

import { logger } from "@/logger";
import type { ServiceInstallRequest } from "@/models/manifest.model";
import type { AdapterPoolService } from "@/services/adapter-pool.service";
import type { EnvironmentPoolService } from "@/services/environment-pool.service";
import type { ManifestService } from "@/services/manifest.service";
import { parseOrHttpError } from "@/utils/validation.util";

const nonEmptyTrimmedString = (fieldName: string) =>
  z
    .string({ error: `Field '${fieldName}' must be a string.` })
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, {
      error: `Field '${fieldName}' must not be empty.`,
    });

const serviceNameSchema = z.string({
  error: "Field 'serviceName' must be a string.",
});

const toolNameSchema = z.string({
  error: "Field 'toolName' must be a string.",
});

const querySchema = z
  .string({ error: "Field 'query' must be a string." })
  .transform((value) => value.trim())
  .transform((value) => (value.length > 0 ? value : undefined));

const enabledQuerySchema = z
  .union([z.boolean(), z.null(), z.string()])
  .transform((value, context): boolean | null => {
    if (typeof value === "boolean" || value === null) {
      return value;
    }

    const normalized = value.trim().toLowerCase();

    if (normalized === "true") {
      return true;
    }

    if (normalized === "false") {
      return false;
    }

    if (normalized === "null") {
      return null;
    }

    context.addIssue({
      code: "custom",
      message: "Field 'enabled' must be true, false, or null.",
    });

    return z.NEVER;
  });

const installSourceSchema = z
  .union([
    z
      .string({
        error: "Field 'source' is required and must be a string or object.",
      })
      .transform((value, context) => {
        const normalized = value.trim();

        if (!normalized) {
          context.addIssue({
            code: "custom",
            message: "Field 'source' must not be empty.",
          });
          return z.NEVER;
        }

        return normalized;
      }),
    z
      .object({
        file_url: z.string().optional(),
        metadata: z
          .object({
            file_url: z.string().optional(),
          })
          .optional(),
      })
      .transform((value, context) => {
        const fromRoot = value.file_url?.trim();
        if (fromRoot) {
          return fromRoot;
        }

        const fromMetadata = value.metadata?.file_url?.trim();
        if (fromMetadata) {
          return fromMetadata;
        }

        context.addIssue({
          code: "custom",
          message:
            "Field 'source.file_url' or 'source.metadata.file_url' is required.",
        });
        return z.NEVER;
      }),
  ])
  .or(
    z.any().transform((_value, context) => {
      context.addIssue({
        code: "custom",
        message: "Field 'source' is required and must be a string or object.",
      });
      return z.NEVER;
    }),
  );

const installPayloadSchema = z
  .object({
    type: nonEmptyTrimmedString("type").or(
      z.any().transform((_value, context) => {
        context.addIssue({
          code: "custom",
          message: "Field 'type' is required and must be a string.",
        });
        return z.NEVER;
      }),
    ),
    source: installSourceSchema,
  })
  .transform((value) => ({
    type: value.type,
    source: value.source,
  }));

const enabledBodySchema = z.object({
  enabled: z.boolean({ error: "Field 'enabled' must be a boolean." }),
});

const jsonPatchOperationSchema = z.union([
  z.object({
    op: z.literal("add"),
    path: z.string().min(1),
    value: z.unknown(),
  }),
  z.object({
    op: z.literal("remove"),
    path: z.string().min(1),
  }),
  z.object({
    op: z.literal("replace"),
    path: z.string().min(1),
    value: z.unknown(),
  }),
  z.object({
    op: z.literal("move"),
    path: z.string().min(1),
    from: z.string().min(1),
  }),
  z.object({
    op: z.literal("copy"),
    path: z.string().min(1),
    from: z.string().min(1),
  }),
  z.object({
    op: z.literal("test"),
    path: z.string().min(1),
    value: z.unknown(),
  }),
]);

const jsonPatchBodySchema: z.ZodType<Operation[]> = z.array(
  jsonPatchOperationSchema,
);

export async function listServices(req: Request, res: Response): Promise<void> {
  const manifestService = getManifestService(req);
  const query = parseQueryParam(req.query?.query);
  const enabled = parseEnabledQueryParam(req.query?.enabled);
  const services = await manifestService.listServices(query, enabled);

  res.status(200).json({ services });
}

export async function getService(req: Request, res: Response): Promise<void> {
  const manifestService = getManifestService(req);
  const serviceName = parseServiceName(req.params.serviceName);
  const service = await manifestService.getService(serviceName);

  res.status(200).json({
    name: service.name,
    type: service.type,
    source: service.source,
    description: service.description,
    hash: service.hash,
    enabled: service.enabled,
    configSchema: service.configSchema,
    secretsSchema: service.secretsSchema,
    metadata: service.metadata,
  });
}

export async function getServiceConfiguration(
  req: Request,
  res: Response,
): Promise<void> {
  const manifestService = getManifestService(req);
  const serviceName = parseServiceName(req.params.serviceName);
  const config = await manifestService.getServiceConfig(serviceName);

  res.status(200).json({ config });
}

export async function getServiceConfigurationSchema(
  req: Request,
  res: Response,
): Promise<void> {
  const manifestService = getManifestService(req);
  const serviceName = parseServiceName(req.params.serviceName);
  const configSchema =
    await manifestService.getServiceConfigSchema(serviceName);

  res.status(200).json({ configSchema });
}

export async function getServiceSecretsSchema(
  req: Request,
  res: Response,
): Promise<void> {
  const manifestService = getManifestService(req);
  const serviceName = parseServiceName(req.params.serviceName);
  const secretsSchema =
    await manifestService.getServiceSecretsSchema(serviceName);

  res.status(200).json({ secretsSchema });
}

export async function patchServiceConfiguration(
  req: Request,
  res: Response,
): Promise<void> {
  const manifestService = getManifestService(req);
  const adapterPoolService = getAdapterPoolService(req);
  const serviceName = parseServiceName(req.params.serviceName);
  const patch = parseOrHttpError(
    jsonPatchBodySchema,
    req.body,
    "Request body must be a JSON Patch array.",
  );

  const config = await manifestService.patchServiceConfig(serviceName, patch);

  try {
    adapterPoolService.updateServiceConfig(serviceName, config);
  } catch (error) {
    logger.warn({ err: error }, "Failed to update adapter configuration");
  }

  try {
    adapterPoolService.requestRestage();
  } catch (error) {
    logger.warn({ err: error }, "Failed to queue adapter restage");
  }

  res.status(200).json({ config });
}

export async function patchServiceSecrets(
  req: Request,
  res: Response,
): Promise<void> {
  const manifestService = getManifestService(req);
  const adapterPoolService = getAdapterPoolService(req);
  const serviceName = parseServiceName(req.params.serviceName);
  const patch = parseOrHttpError(
    jsonPatchBodySchema,
    req.body,
    "Request body must be a JSON Patch array.",
  );

  const secrets = await manifestService.patchServiceSecrets(serviceName, patch);

  try {
    adapterPoolService.updateServiceSecrets(serviceName, secrets);
  } catch (error) {
    logger.warn({ err: error }, "Failed to update adapter secrets");
  }

  try {
    adapterPoolService.requestRestage();
  } catch (error) {
    logger.warn({ err: error }, "Failed to queue adapter restage");
  }

  res.status(200).json({ updated: true });
}

export async function listTools(req: Request, res: Response): Promise<void> {
  const manifestService = getManifestService(req);
  const serviceName = parseServiceName(req.params.serviceName);
  const query = parseQueryParam(req.query?.query);
  const enabled = parseEnabledQueryParam(req.query?.enabled);
  const tools = await manifestService.listTools(serviceName, query, enabled);

  res.status(200).json({ tools });
}

export async function getToolByName(
  req: Request,
  res: Response,
): Promise<void> {
  const manifestService = getManifestService(req);
  const serviceName = parseServiceName(req.params.serviceName);
  const toolName = parseToolName(req.params.toolName);
  const { tool, serviceEnabled } = await manifestService.getTool(
    serviceName,
    toolName,
  );

  res.status(200).json({
    name: tool.name,
    description: tool.description,
    enabled: serviceEnabled && tool.enabled,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    metadata: tool.metadata,
  });
}

export async function createService(
  req: Request,
  res: Response,
): Promise<void> {
  const manifestService = getManifestService(req);
  const environmentPoolService = getEnvironmentPoolService(req);
  const payload = parseInstallServicePayload(req.body);
  const service = await manifestService.createService(payload);

  try {
    environmentPoolService.requestRestage();
  } catch (error) {
    logger.warn({ err: error }, "Failed to queue environment restage");
  }

  res.status(201).json(service);
}

export async function updateService(
  req: Request,
  res: Response,
): Promise<void> {
  const manifestService = getManifestService(req);
  const environmentPoolService = getEnvironmentPoolService(req);
  const serviceName = parseServiceName(req.params.serviceName);

  const updated = await manifestService.updateService(serviceName);

  if (updated) {
    try {
      environmentPoolService.requestRestage();
    } catch (error) {
      logger.warn({ err: error }, "Failed to queue environment restage");
    }
  }

  res.status(200).json({ name: serviceName, updated });
}

export async function setServiceEnabled(
  req: Request,
  res: Response,
): Promise<void> {
  const manifestService = getManifestService(req);
  const serviceName = parseServiceName(req.params.serviceName);
  const enabled = parseEnabled(req.body);

  await manifestService.setServiceEnabled(serviceName, enabled);
  res.status(200).json({ name: serviceName, enabled });
}

export async function setToolEnabled(
  req: Request,
  res: Response,
): Promise<void> {
  const manifestService = getManifestService(req);
  const serviceName = parseServiceName(req.params.serviceName);
  const toolName = parseToolName(req.params.toolName);
  const enabled = parseEnabled(req.body);

  await manifestService.setToolEnabled(serviceName, toolName, enabled);
  res.status(200).json({ name: toolName, serviceName, enabled });
}

export async function deleteService(
  req: Request,
  res: Response,
): Promise<void> {
  const manifestService = getManifestService(req);
  const environmentPoolService = getEnvironmentPoolService(req);
  const serviceName = parseServiceName(req.params.serviceName);

  await manifestService.deleteService(serviceName);

  try {
    environmentPoolService.requestRestage();
  } catch (error) {
    logger.warn({ err: error }, "Failed to queue environment restage");
  }

  res.status(204).send();
}

function parseServiceName(raw: unknown): string {
  return parseOrHttpError(serviceNameSchema, raw);
}

function parseToolName(raw: unknown): string {
  return parseOrHttpError(toolNameSchema, raw);
}

function parseQueryParam(raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  return parseOrHttpError(querySchema, raw);
}

function parseEnabledQueryParam(raw: unknown): boolean | null {
  if (raw === undefined) {
    return null;
  }

  return parseOrHttpError(enabledQuerySchema, raw);
}

function parseInstallServicePayload(rawBody: unknown): ServiceInstallRequest {
  return parseOrHttpError(
    installPayloadSchema,
    rawBody,
    "Request body must be an object.",
  );
}

function parseEnabled(rawBody: unknown): boolean {
  const parsed = parseOrHttpError(
    enabledBodySchema,
    rawBody,
    "Request body must be an object.",
  );

  return parsed.enabled;
}

function getManifestService(req: Request): ManifestService {
  const service = req.app.locals.manifestService as ManifestService | undefined;

  if (!service) {
    throw new Error("ManifestService not configured in app.locals");
  }

  return service;
}

function getEnvironmentPoolService(req: Request): EnvironmentPoolService {
  const service = req.app.locals.environmentPoolService as
    | EnvironmentPoolService
    | undefined;

  if (!service) {
    throw new Error("EnvironmentPoolService not configured in app.locals");
  }

  return service;
}

function getAdapterPoolService(req: Request): AdapterPoolService {
  const service = req.app.locals.adapterPoolService as
    | AdapterPoolService
    | undefined;

  if (!service) {
    throw new Error("AdapterPoolService not configured in app.locals");
  }

  return service;
}
