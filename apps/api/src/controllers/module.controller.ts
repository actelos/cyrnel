import type { AuthScheme, SecurityRequirements } from "@cyrnel/sdk";
import type { Request, Response } from "express";
import type { Operation } from "fast-json-patch";
import { z } from "zod";
import { HttpError } from "@/models/error.model";
import {
  type FilterModuleManifestInput,
  MODULE_TYPES,
  type ModuleManifestRecord,
  type ModuleType,
} from "@/models/modules.model";
import type { ModuleService } from "@/services/modules.service";
import { sendIconResponse } from "@/utils/icon-response.util";
import { paginationQuerySchema } from "@/utils/pagination.util";
import { parseOrHttpError } from "@/utils/validation.util";

const nonEmptyTrimmedString = (fieldName: string) =>
  z
    .string({ error: `Field '${fieldName}' must be a string.` })
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, {
      error: `Field '${fieldName}' must not be empty.`,
    });

const installModuleRegistryBodySchema = z.object({
  source: nonEmptyTrimmedString("source"),
  version: nonEmptyTrimmedString("version").optional(),
});

const createModuleBodySchema = z.object({
  url: nonEmptyTrimmedString("url"),
});

const patchModuleBodySchema = z.object({
  url: nonEmptyTrimmedString("url"),
});

const booleanSchema = (fieldName: string) =>
  z.union([z.boolean(), z.string()]).transform((value, ctx): boolean => {
    if (typeof value === "boolean") return value;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    ctx.addIssue({
      code: "custom",
      message: `Field '${fieldName}' must be true or false.`,
    });
    return z.NEVER;
  });

const enabledSchema = z
  .union([z.boolean(), z.string()])
  .transform((value, ctx): boolean => {
    if (typeof value === "boolean") return value;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    ctx.addIssue({
      code: "custom",
      message: "Field 'enabled' must be true or false.",
    });
    return z.NEVER;
  });

const moduleIdSchema = z
  .string({ error: "Field 'moduleId' must be a string." })
  .transform((v) => v.trim())
  .refine((v) => v.length > 0, {
    error: "Field 'moduleId' must not be empty.",
  });

const enabledBodySchema = z.object({
  enabled: z.boolean({ error: "Field 'enabled' must be a boolean." }),
});

const jsonPointerSchema = z.string();

const jsonPatchOperationSchema = z.union([
  z.object({
    op: z.literal("add"),
    path: jsonPointerSchema,
    value: z.unknown(),
  }),
  z.object({
    op: z.literal("remove"),
    path: jsonPointerSchema,
  }),
  z.object({
    op: z.literal("replace"),
    path: jsonPointerSchema,
    value: z.unknown(),
  }),
  z.object({
    op: z.literal("move"),
    path: jsonPointerSchema,
    from: jsonPointerSchema,
  }),
  z.object({
    op: z.literal("copy"),
    path: jsonPointerSchema,
    from: jsonPointerSchema,
  }),
  z.object({
    op: z.literal("test"),
    path: jsonPointerSchema,
    value: z.unknown(),
  }),
]);

const jsonPatchBodySchema: z.ZodType<Operation[]> = z.array(
  jsonPatchOperationSchema,
);

function parseOptional<T>(schema: z.ZodType<T>, raw: unknown): T | undefined {
  return raw === undefined ? undefined : parseOrHttpError(schema, raw);
}

function getModuleService(req: Request): ModuleService {
  const service = req.app.locals.moduleService as ModuleService | undefined;
  if (!service) throw new Error("ModuleService not configured in app.locals");
  return service;
}

export async function installModule(
  req: Request,
  res: Response,
): Promise<void> {
  const moduleService = getModuleService(req);
  const { source, version } = parseOrHttpError(
    installModuleRegistryBodySchema,
    req.body,
    "Request body must be an object.",
  );

  const manifest = await moduleService.installModuleFromRegistry(
    source,
    version,
  );
  res.status(201).json(manifest);
}

export async function createModule(req: Request, res: Response): Promise<void> {
  const moduleService = getModuleService(req);
  const { url } = parseOrHttpError(
    createModuleBodySchema,
    req.body,
    "Request body must be an object.",
  );

  const manifest = await moduleService.installModuleDirect(url);
  res.status(201).json(manifest);
}

export async function patchModule(req: Request, res: Response): Promise<void> {
  const moduleService = getModuleService(req);
  const moduleId = parseOrHttpError(moduleIdSchema, req.params.moduleId);
  const { url } = parseOrHttpError(
    patchModuleBodySchema,
    req.body,
    "Request body must be an object.",
  );

  const result = await moduleService.patchModule(moduleId, url);
  res.status(200).json(result);
}

export async function deleteModule(req: Request, res: Response): Promise<void> {
  const moduleService = getModuleService(req);
  const moduleId = parseOrHttpError(moduleIdSchema, req.params.moduleId);

  await moduleService.deleteModule(moduleId);
  res.status(204).send();
}

export async function updateModule(req: Request, res: Response): Promise<void> {
  const moduleService = getModuleService(req);
  const moduleId = parseOrHttpError(moduleIdSchema, req.params.moduleId);

  const result = await moduleService.updateModule(moduleId);
  res.status(200).json(result);
}

export async function listModules(req: Request, res: Response): Promise<void> {
  const pagination = parseOrHttpError(
    paginationQuerySchema,
    req.query,
    "Invalid query parameters.",
  );
  const filters: FilterModuleManifestInput = {
    query: parseOptional(
      z
        .string({ error: "Field 'query' must be a string." })
        .transform((v) => v.trim())
        .transform((v) => v || undefined),
      req.query?.query,
    ),
    type: parseOptional(
      z
        .string({ error: "Field 'type' must be a string." })
        .transform((v) => v.trim())
        .refine(
          (v): v is ModuleType => MODULE_TYPES.includes(v as ModuleType),
          { error: `Field 'type' must be one of: ${MODULE_TYPES.join(", ")}.` },
        ),
      req.query?.type,
    ),
    isBuiltin: parseOptional(booleanSchema("isBuiltin"), req.query?.isBuiltin),
    enabled: parseOptional(enabledSchema, req.query?.enabled),
    missing: parseOptional(booleanSchema("missing"), req.query?.missing),
    limit: pagination.limit,
    cursor: pagination.cursor,
  };

  const result = await getModuleService(req).list(filters);
  res.status(200).json(result);
}

export async function getModule(req: Request, res: Response): Promise<void> {
  const moduleId = parseOrHttpError(moduleIdSchema, req.params.moduleId);

  const module: ModuleManifestRecord | undefined =
    await getModuleService(req).get(moduleId);
  if (!module) throw new HttpError(404, `Module '${moduleId}' not found.`);

  res.status(200).json(module);
}

export async function getModuleIcon(
  req: Request,
  res: Response,
): Promise<void> {
  const moduleService = getModuleService(req);
  const moduleId = parseOrHttpError(moduleIdSchema, req.params.moduleId);
  const icon = await moduleService.getIcon(moduleId);

  sendIconResponse(res, icon, `Module '${moduleId}'`);
}

export async function setModuleEnabled(
  req: Request,
  res: Response,
): Promise<void> {
  const moduleService = getModuleService(req);
  const moduleId = parseOrHttpError(moduleIdSchema, req.params.moduleId);
  const { enabled } = parseOrHttpError(
    enabledBodySchema,
    req.body,
    "Request body must be an object.",
  );

  await moduleService.setEnabled({ id: moduleId, enabled });
  res.status(200).end();
}

export async function reloadModules(
  req: Request,
  res: Response,
): Promise<void> {
  await getModuleService(req).reload();
  res.status(200).end();
}

export async function getModuleConfiguration(
  req: Request,
  res: Response,
): Promise<void> {
  const moduleService = getModuleService(req);
  const moduleId = parseOrHttpError(moduleIdSchema, req.params.moduleId);
  const view = await moduleService.getConfigView(moduleId);
  res.status(200).json(view);
}

export async function getModuleConfigurationSchema(
  req: Request,
  res: Response,
): Promise<void> {
  const moduleService = getModuleService(req);
  const moduleId = parseOrHttpError(moduleIdSchema, req.params.moduleId);
  const configSchema = moduleService.getConfigSchema(moduleId);
  res.status(200).json({ configSchema });
}

export async function getModuleSecrets(
  req: Request,
  res: Response,
): Promise<void> {
  const moduleService = getModuleService(req);
  const moduleId = parseOrHttpError(moduleIdSchema, req.params.moduleId);
  const result = await moduleService.getSecretsPresence(moduleId);

  res.status(200).json(result);
}

export async function getModuleSecretsSchema(
  req: Request,
  res: Response,
): Promise<void> {
  const moduleService = getModuleService(req);
  const moduleId = parseOrHttpError(moduleIdSchema, req.params.moduleId);
  const secretsSchema = moduleService.getSecretsSchema(moduleId);
  res.status(200).json({ secretsSchema });
}

export async function patchModuleConfiguration(
  req: Request,
  res: Response,
): Promise<void> {
  const moduleService = getModuleService(req);
  const moduleId = parseOrHttpError(moduleIdSchema, req.params.moduleId);
  const patch = parseOrHttpError(
    jsonPatchBodySchema,
    req.body,
    "Request body must be a JSON Patch array.",
  );

  const view = await moduleService.patchConfig({ id: moduleId, patch });
  res.status(200).json(view);
}

export async function patchModuleSecrets(
  req: Request,
  res: Response,
): Promise<void> {
  const moduleService = getModuleService(req);
  const moduleId = parseOrHttpError(moduleIdSchema, req.params.moduleId);
  const patch = parseOrHttpError(
    jsonPatchBodySchema,
    req.body,
    "Request body must be a JSON Patch array.",
  );

  await moduleService.patchSecrets({ id: moduleId, patch });
  res.status(200).json({ updated: true });
}

export async function restartModule(
  req: Request,
  res: Response,
): Promise<void> {
  const moduleService = getModuleService(req);
  const moduleId = parseOrHttpError(moduleIdSchema, req.params.moduleId);

  await moduleService.restartModule(moduleId);
  res.status(200).end();
}

export async function setModuleAuth(
  req: Request,
  res: Response,
): Promise<void> {
  const moduleService = getModuleService(req);
  const moduleId = parseOrHttpError(moduleIdSchema, req.params.moduleId);
  const apiKeySchemeSchema = z.object({
    type: z.literal("apiKey"),
    in: z.enum(["header", "query", "cookie"]),
    paramName: z.string().min(1),
    prefix: z.string().optional(),
  });
  const basicSchemeSchema = z.object({ type: z.literal("basic") });
  const httpSchemeSchema = z.object({
    type: z.literal("http"),
    scheme: z.literal("bearer"),
    bearerFormat: z.string().optional(),
  });
  const oauth2SchemeSchema = z
    .object({
      type: z.literal("oauth2"),
      grantTypes: z
        .array(z.enum(["authorizationCode", "clientCredentials", "deviceCode"]))
        .min(1),
      authorizationUrl: z.string().optional(),
      deviceAuthorizationUrl: z.string().optional(),
      tokenUrl: z.string().min(1),
      scopes: z.record(z.string(), z.string()).optional().default({}),
      clientAuthMethod: z
        .enum([
          "client_secret_basic",
          "client_secret_post",
          "private_key_jwt",
          "none",
        ])
        .optional(),
      additionalTokenParams: z.record(z.string(), z.string()).optional(),
      tokenPlacement: z.object({
        in: z.literal("header"),
        paramName: z.string().min(1),
        prefix: z.string().optional(),
      }),
    })
    .refine(
      (val) => {
        if (
          val.grantTypes.includes("authorizationCode") &&
          !val.authorizationUrl
        ) {
          return false;
        }
        if (
          val.grantTypes.includes("deviceCode") &&
          !val.deviceAuthorizationUrl
        ) {
          return false;
        }
        return true;
      },
      {
        message:
          "authorizationUrl is required when grantTypes includes authorizationCode; deviceAuthorizationUrl is required when grantTypes includes deviceCode",
        path: ["authorizationUrl", "deviceAuthorizationUrl"],
      },
    );
  const authSchemeSchema = z.discriminatedUnion("type", [
    apiKeySchemeSchema,
    basicSchemeSchema,
    httpSchemeSchema,
    oauth2SchemeSchema,
  ]);
  const body = parseOrHttpError(
    z.object({
      schemes: z
        .record(z.string(), authSchemeSchema)
        .refine((val) => Object.keys(val).length > 0, {
          error: "Field 'schemes' must declare at least one scheme.",
        }),
      security: z.array(z.record(z.string(), z.array(z.string()))),
    }),
    req.body,
    "Request body must be an object.",
  );

  await moduleService.setModuleAuth({
    id: moduleId,
    schemes: body.schemes as unknown as Record<string, AuthScheme>,
    security: body.security as SecurityRequirements,
  });
  res.status(200).json({ updated: true });
}
