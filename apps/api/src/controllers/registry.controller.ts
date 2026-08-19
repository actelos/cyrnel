import type { Request, Response } from "express";
import { z } from "zod";

import { MODULE_TYPES } from "@/models/modules.model";
import type { RegistriesService } from "@/services/registries.service";
import { fetchAndValidateIcon } from "@/utils/icon.util";
import { paginationQuerySchema } from "@/utils/pagination.util";
import { parseOrHttpError } from "@/utils/validation.util";

const trimmedString = (fieldName: string) =>
  z
    .string({ error: `Field '${fieldName}' must be a string.` })
    .transform((value) => value.trim());

const nonEmptyTrimmedString = (fieldName: string) =>
  trimmedString(fieldName).refine((value) => value.length > 0, {
    error: `Field '${fieldName}' must not be empty.`,
    path: [fieldName],
  });

const registryIdSchema = z.string({
  error: "Field 'id' must be a string.",
});

const registryIdBodySchema = trimmedString("id").refine(
  (value) => /^[A-Za-z0-9_-]+$/.test(value),
  {
    error: "Field 'id' must be a slug matching /^[A-Za-z0-9_-]+$/.",
    path: ["id"],
  },
);

const registryBaseUrlBodySchema = trimmedString("baseUrl").refine(isHttpUrl, {
  error: "Field 'baseUrl' must be a valid absolute http(s) URL.",
  path: ["baseUrl"],
});

const createRegistryBodySchema = z.object({
  id: registryIdBodySchema,
  baseUrl: registryBaseUrlBodySchema,
});

const apiKeyAuthSchema = z.object({
  type: z.literal("apiKey"),
  apiKey: nonEmptyTrimmedString("apiKey"),
});

const oauthAuthSchema = z.object({
  type: z.literal("oauth2"),
  clientId: nonEmptyTrimmedString("clientId"),
  clientSecret: nonEmptyTrimmedString("clientSecret"),
  scopes: z.array(nonEmptyTrimmedString("scopes")).optional(),
});

const registryAuthBodySchema = z.discriminatedUnion("type", [
  apiKeyAuthSchema,
  oauthAuthSchema,
]);

export async function listRegistries(
  req: Request,
  res: Response,
): Promise<void> {
  const registriesService = getRegistriesService(req);
  const pagination = parseOrHttpError(
    paginationQuerySchema,
    req.query,
    "Invalid query parameters.",
  );
  const result = await registriesService.listRegistries({
    limit: pagination.limit,
    cursor: pagination.cursor,
  });

  res.status(200).json(result);
}

export async function createRegistry(
  req: Request,
  res: Response,
): Promise<void> {
  const registriesService = getRegistriesService(req);
  const payload = parseOrHttpError(
    createRegistryBodySchema,
    req.body,
    "Request body must be an object.",
  );

  const record = await registriesService.createRegistry(payload);

  res.status(201).json(record);
}

export async function deleteRegistry(
  req: Request,
  res: Response,
): Promise<void> {
  const registriesService = getRegistriesService(req);
  const id = parseRegistryId(req.params.id);

  await registriesService.deleteRegistry(id);

  res.status(204).send();
}

function parseRegistryId(raw: unknown): string {
  return parseOrHttpError(registryIdSchema, raw);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const addRegistryBodySchema = z.object({
  baseUrl: registryBaseUrlBodySchema,
  id: registryIdBodySchema.optional(),
  auth: registryAuthBodySchema.optional(),
});

const browseQuerySchema = z.object({
  query: nonEmptyTrimmedString("query").optional(),
  cursor: nonEmptyTrimmedString("cursor").optional(),
  limit: z.coerce
    .number({ error: "Field 'limit' must be a number." })
    .int({ error: "Field 'limit' must be a positive integer." })
    .positive({ error: "Field 'limit' must be a positive integer." })
    .max(200, { error: "Field 'limit' must be at most 200." })
    .optional(),
});

const browseDefinitionsQuerySchema = browseQuerySchema.extend({
  kind: nonEmptyTrimmedString("kind").optional(),
});

const browseModulesQuerySchema = browseQuerySchema.extend({
  type: z.enum(MODULE_TYPES).optional(),
});

export async function addRegistry(req: Request, res: Response): Promise<void> {
  const registriesService = getRegistriesService(req);
  const payload = parseOrHttpError(
    addRegistryBodySchema,
    req.body,
    "Request body must be an object.",
  );
  const record = await registriesService.addRegistry(
    payload.baseUrl,
    payload.id,
    payload.auth,
  );
  res.status(201).json(record);
}

export async function setRegistryAuth(
  req: Request,
  res: Response,
): Promise<void> {
  const registriesService = getRegistriesService(req);
  const id = parseRegistryId(req.params.id);
  const payload = parseOrHttpError(
    registryAuthBodySchema,
    req.body,
    "Request body must be an object.",
  );
  const result = await registriesService.setRegistryAuth(id, payload);
  res.status(200).json(result);
}

export async function deleteRegistryAuth(
  req: Request,
  res: Response,
): Promise<void> {
  const registriesService = getRegistriesService(req);
  const id = parseRegistryId(req.params.id);

  await registriesService.deleteRegistryAuth(id);

  res.status(204).send();
}

export async function refreshRegistry(
  req: Request,
  res: Response,
): Promise<void> {
  const registriesService = getRegistriesService(req);
  const id = parseRegistryId(req.params.id);
  const record = await registriesService.refreshRegistry(id);
  res.status(200).json(record);
}

export async function browseDefinitions(
  req: Request,
  res: Response,
): Promise<void> {
  const registriesService = getRegistriesService(req);
  const id = parseRegistryId(req.params.id);
  const query = parseOrHttpError(
    browseDefinitionsQuerySchema,
    req.query,
    "Invalid query parameters.",
  );
  const page = await registriesService.browseDefinitions(id, query);
  res
    .status(200)
    .json({ definitions: page.entries, nextCursor: page.nextCursor });
}

export async function browseModules(
  req: Request,
  res: Response,
): Promise<void> {
  const registriesService = getRegistriesService(req);
  const id = parseRegistryId(req.params.id);
  const query = parseOrHttpError(
    browseModulesQuerySchema,
    req.query,
    "Invalid query parameters.",
  );
  const page = await registriesService.browseModules(id, query);
  res.status(200).json({ modules: page.entries, nextCursor: page.nextCursor });
}

export async function getDefinitionIcon(
  req: Request,
  res: Response,
): Promise<void> {
  const registriesService = getRegistriesService(req);
  const id = parseRegistryId(req.params.id);
  const defId = parseRegistryId(req.params.defId);
  const page = await registriesService.browseDefinitions(id, { query: defId });
  const entry = page.entries.find((e) => e.id === defId);
  if (!entry?.icon) {
    res.status(404).json({ error: "Icon not found." });
    return;
  }
  const icon = await fetchAndValidateIcon(entry.icon, "service", defId);
  if (!icon) {
    res.status(404).json({ error: "Icon not available." });
    return;
  }
  res.set("Content-Type", icon.mime);
  res.set("Cache-Control", "public, max-age=86400");
  res.set("ETag", `"${icon.hash}"`);
  res.send(icon.data);
}

export async function getModuleIcon(
  req: Request,
  res: Response,
): Promise<void> {
  const registriesService = getRegistriesService(req);
  const id = parseRegistryId(req.params.id);
  const modId = parseRegistryId(req.params.modId);
  const page = await registriesService.browseModules(id, { query: modId });
  const entry = page.entries.find((e) => e.id === modId);
  if (!entry?.icon) {
    res.status(404).json({ error: "Icon not found." });
    return;
  }
  const icon = await fetchAndValidateIcon(entry.icon, "module", modId);
  if (!icon) {
    res.status(404).json({ error: "Icon not available." });
    return;
  }
  res.set("Content-Type", icon.mime);
  res.set("Cache-Control", "public, max-age=86400");
  res.set("ETag", `"${icon.hash}"`);
  res.send(icon.data);
}

function getRegistriesService(req: Request): RegistriesService {
  const service = req.app.locals.registriesService as
    | RegistriesService
    | undefined;

  if (!service) {
    throw new Error("RegistriesService not configured in app.locals");
  }

  return service;
}
