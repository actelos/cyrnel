import type { Request, Response } from "express";
import type { Operation } from "fast-json-patch";
import { z } from "zod";

import type { ServicesService } from "@/services/services.service";
import { parseOrHttpError } from "@/utils/validation.util";

const nonEmptyTrimmedString = (fieldName: string) =>
  z
    .string({ error: `Field '${fieldName}' must be a string.` })
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, {
      error: `Field '${fieldName}' must not be empty.`,
    });

const serviceIdSchema = z.string({
  error: "Field 'serviceId' must be a string.",
});

const querySchema = z
  .string({ error: "Field 'query' must be a string." })
  .transform((value) => value.trim())
  .transform((value) => (value.length > 0 ? value : undefined));

function booleanQueryParamSchema(fieldName: string) {
  return z
    .union([z.boolean(), z.string()])
    .transform((value, context): boolean | undefined => {
      if (typeof value === "boolean") {
        return value;
      }

      const normalized = value.trim().toLowerCase();

      if (normalized === "true") {
        return true;
      }

      if (normalized === "false") {
        return false;
      }

      context.addIssue({
        code: "custom",
        message: `Field '${fieldName}' must be true or false.`,
      });

      return z.NEVER;
    });
}

const enabledQuerySchema = booleanQueryParamSchema("enabled");
const staleQuerySchema = booleanQueryParamSchema("stale");

const createServiceDirectBodySchema = z.object({
  id: nonEmptyTrimmedString("id"),
  url: nonEmptyTrimmedString("url"),
  adapter: nonEmptyTrimmedString("adapter"),
});

const installServiceRegistryBodySchema = z.object({
  source: nonEmptyTrimmedString("source"),
  adapter: nonEmptyTrimmedString("adapter").optional(),
  id: nonEmptyTrimmedString("id").optional(),
  version: nonEmptyTrimmedString("version").optional(),
});

const patchServiceBodySchema = z.object({
  url: nonEmptyTrimmedString("url"),
});

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
  const servicesService = getServicesService(req);
  const query = parseQueryParam(req.query?.query);
  const enabled = parseEnabledQueryParam(req.query?.enabled);
  const adapter = parseAdapterQueryParam(req.query?.adapter);
  const stale = parseStaleQueryParam(req.query?.stale);
  const services = await servicesService.listServices({
    query,
    enabled,
    adapter,
    stale,
  });

  res.status(200).json({ services });
}

export async function getService(req: Request, res: Response): Promise<void> {
  const servicesService = getServicesService(req);
  const serviceId = parseServiceId(req.params.serviceId);
  const service = await servicesService.getService(serviceId);

  res.status(200).json(service);
}

export async function getServiceConfiguration(
  req: Request,
  res: Response,
): Promise<void> {
  const servicesService = getServicesService(req);
  const serviceId = parseServiceId(req.params.serviceId);
  const config = await servicesService.getServiceConfig(serviceId);

  res.status(200).json({ config });
}

export async function getServiceConfigurationSchema(
  req: Request,
  res: Response,
): Promise<void> {
  const servicesService = getServicesService(req);
  const serviceId = parseServiceId(req.params.serviceId);
  const configSchema = await servicesService.getServiceConfigSchema(serviceId);

  res.status(200).json({ configSchema });
}

export async function getServiceSecrets(
  req: Request,
  res: Response,
): Promise<void> {
  const servicesService = getServicesService(req);
  const serviceId = parseServiceId(req.params.serviceId);
  const result = await servicesService.getServiceSecretsPresence(serviceId);

  res.status(200).json(result);
}

export async function getServiceSecretsSchema(
  req: Request,
  res: Response,
): Promise<void> {
  const servicesService = getServicesService(req);
  const serviceId = parseServiceId(req.params.serviceId);
  const secretsSchema =
    await servicesService.getServiceSecretsSchema(serviceId);

  res.status(200).json({ secretsSchema });
}

export async function patchServiceConfiguration(
  req: Request,
  res: Response,
): Promise<void> {
  const servicesService = getServicesService(req);
  const serviceId = parseServiceId(req.params.serviceId);
  const patch = parseOrHttpError(
    jsonPatchBodySchema,
    req.body,
    "Request body must be a JSON Patch array.",
  );

  await servicesService.patchServiceConfig({ id: serviceId, patch });
  const config = await servicesService.getServiceConfig(serviceId);

  res.status(200).json({ config });
}

export async function patchServiceSecrets(
  req: Request,
  res: Response,
): Promise<void> {
  const servicesService = getServicesService(req);
  const serviceId = parseServiceId(req.params.serviceId);
  const patch = parseOrHttpError(
    jsonPatchBodySchema,
    req.body,
    "Request body must be a JSON Patch array.",
  );

  await servicesService.patchServiceSecrets({ id: serviceId, patch });

  res.status(200).json({ updated: true });
}

export async function createServiceDirect(
  req: Request,
  res: Response,
): Promise<void> {
  const servicesService = getServicesService(req);
  const payload = parseOrHttpError(
    createServiceDirectBodySchema,
    req.body,
    "Request body must be an object.",
  );

  await servicesService.createServiceDirect(payload);

  res.status(201).json({ id: payload.id });
}

export async function installServiceRegistry(
  req: Request,
  res: Response,
): Promise<void> {
  const servicesService = getServicesService(req);
  const payload = parseOrHttpError(
    installServiceRegistryBodySchema,
    req.body,
    "Request body must be an object.",
  );

  const id = await servicesService.createServiceFromRegistry(payload);

  res.status(201).json({ id });
}

export async function patchService(req: Request, res: Response): Promise<void> {
  const servicesService = getServicesService(req);
  const serviceId = parseServiceId(req.params.serviceId);
  const { url } = parseOrHttpError(
    patchServiceBodySchema,
    req.body,
    "Request body must be an object.",
  );

  const result = await servicesService.patchService(serviceId, url);

  res.status(200).json(result);
}

export async function syncService(req: Request, res: Response): Promise<void> {
  const servicesService = getServicesService(req);
  const serviceId = parseServiceId(req.params.serviceId);

  await servicesService.syncService(serviceId);

  res.status(200).json({ id: serviceId, updated: true });
}

export async function updateService(
  req: Request,
  res: Response,
): Promise<void> {
  const servicesService = getServicesService(req);
  const serviceId = parseServiceId(req.params.serviceId);

  await servicesService.updateService(serviceId);

  res.status(200).json({ id: serviceId, updated: true });
}

export async function setServiceEnabled(
  req: Request,
  res: Response,
): Promise<void> {
  const servicesService = getServicesService(req);
  const serviceId = parseServiceId(req.params.serviceId);
  const { enabled } = parseOrHttpError(
    enabledBodySchema,
    req.body,
    "Request body must be an object.",
  );

  await servicesService.setServiceEnabled({ id: serviceId, enabled });
  res.status(200).json({ id: serviceId, enabled });
}

export async function deleteService(
  req: Request,
  res: Response,
): Promise<void> {
  const servicesService = getServicesService(req);
  const serviceId = parseServiceId(req.params.serviceId);

  await servicesService.deleteService(serviceId);

  res.status(204).send();
}

function parseServiceId(raw: unknown): string {
  return parseOrHttpError(serviceIdSchema, raw);
}

function parseQueryParam(raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  return parseOrHttpError(querySchema, raw);
}

function parseEnabledQueryParam(raw: unknown): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }

  return parseOrHttpError(enabledQuerySchema, raw);
}

function parseAdapterQueryParam(raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  return parseOrHttpError(querySchema, raw);
}

function parseStaleQueryParam(raw: unknown): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }

  return parseOrHttpError(staleQuerySchema, raw);
}

function getServicesService(req: Request): ServicesService {
  const service = req.app.locals.servicesService as ServicesService | undefined;

  if (!service) {
    throw new Error("ServicesService not configured in app.locals");
  }

  return service;
}
