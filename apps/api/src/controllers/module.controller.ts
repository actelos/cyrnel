import type { Request, Response } from "express";
import type { Operation } from "fast-json-patch";
import { z } from "zod";
import { HttpError } from "@/models/error.model";
import {
  type FilterModuleManifestInput,
  type ListModuleManifestResult,
  MODULE_TYPES,
  type ModuleManifestRecord,
  type ModuleType,
} from "@/models/modules.model";
import type { ModuleService } from "@/services/modules.service";
import { parseOrHttpError } from "@/utils/validation.util";

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
  .union([z.boolean(), z.null(), z.string()])
  .transform((value, ctx): boolean | null => {
    if (typeof value === "boolean" || value === null) return value;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    if (normalized === "null") return null;
    ctx.addIssue({
      code: "custom",
      message: "Field 'enabled' must be true, false, or null.",
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

function parseOptional<T>(schema: z.ZodType<T>, raw: unknown): T | undefined {
  return raw === undefined ? undefined : parseOrHttpError(schema, raw);
}

function getModuleService(req: Request): ModuleService {
  const service = req.app.locals.moduleService as ModuleService | undefined;
  if (!service) throw new Error("ModuleService not configured in app.locals");
  return service;
}

export async function listModules(req: Request, res: Response): Promise<void> {
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
  };

  const modules: ListModuleManifestResult[] =
    await getModuleService(req).list(filters);
  res.status(200).json({ modules });
}

export async function getModule(req: Request, res: Response): Promise<void> {
  const moduleId = parseOrHttpError(moduleIdSchema, req.params.moduleId);

  const module: ModuleManifestRecord | undefined =
    await getModuleService(req).get(moduleId);
  if (!module) throw new HttpError(404, `Module '${moduleId}' not found.`);

  res.status(200).json(module);
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
  const config = await moduleService.getConfig(moduleId);
  res.status(200).json({ config });
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

  await moduleService.patchConfig({ id: moduleId, patch });
  const config = await moduleService.getConfig(moduleId);
  res.status(200).json({ config });
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
