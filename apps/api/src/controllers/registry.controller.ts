import type { Request, Response } from "express";
import { z } from "zod";

import type { RegistriesService } from "@/services/registries.service";
import { paginationQuerySchema } from "@/utils/pagination.util";
import { parseOrHttpError } from "@/utils/validation.util";

const trimmedString = (fieldName: string) =>
  z
    .string({ error: `Field '${fieldName}' must be a string.` })
    .transform((value) => value.trim());

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

function getRegistriesService(req: Request): RegistriesService {
  const service = req.app.locals.registriesService as
    | RegistriesService
    | undefined;

  if (!service) {
    throw new Error("RegistriesService not configured in app.locals");
  }

  return service;
}
