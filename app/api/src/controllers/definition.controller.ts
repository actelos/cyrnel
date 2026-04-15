import type { Request, Response } from "express";

import { HttpError } from "@/models/error.model";
import type { DefinitionService } from "@/services/definition.service";

type DefinitionSortField = "type";

export async function listDefinitions(
  req: Request,
  res: Response,
): Promise<void> {
  const definitionService = getDefinitionService(req);
  const sort = parseDefinitionSort(req.query.sort);
  const definitionId = parseDefinitionIdFilter(req.query.id);
  const query = parseQueryParam(req.query.query);
  const definitions = await definitionService.listDefinitions({
    sortBy: sort,
    definitionId,
    query,
  });

  res.status(200).json({ definitions });
}

export async function getDefinition(
  req: Request,
  res: Response,
): Promise<void> {
  const definitionService = getDefinitionService(req);
  const definitionId = parseDefinitionId(req.params.definitionId);
  const definition = await definitionService.getDefinition(definitionId);

  res.status(200).json(definition);
}

export async function createDefinition(
  req: Request,
  res: Response,
): Promise<void> {
  const definitionService = getDefinitionService(req);
  const payload = parseCreateDefinitionPayload(req);

  const definition = await definitionService.createDefinition(
    payload.type,
    payload.description,
    payload.content,
  );

  res.status(201).json(definition);
}

export async function installDefinition(
  req: Request,
  res: Response,
): Promise<void> {
  const definitionService = getDefinitionService(req);
  const payload = parseInstallDefinitionPayload(req);

  const definition = await definitionService.installDefinitionFromRegistry(
    payload.type,
    payload.description,
    payload.fileUrl,
  );

  res.status(201).json(definition);
}

export async function deleteDefinition(
  req: Request,
  res: Response,
): Promise<void> {
  const definitionService = getDefinitionService(req);
  const definitionId = parseDefinitionId(req.params.definitionId);

  await definitionService.deleteDefinition(definitionId);
  res.status(204).send();
}

function parseCreateDefinitionPayload(req: Request): {
  type: string;
  description: string;
  content: string;
} {
  const body = parseDefinitionBody(req.body);
  const type = parseDefinitionType(body);
  const description = parseDefinitionDescription(body);
  const file = req.file;

  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw new HttpError(
      400,
      "Field 'file' is required and must be uploaded as binary data.",
    );
  }

  return {
    type,
    description,
    content: file.buffer.toString("utf8"),
  };
}

function parseInstallDefinitionPayload(req: Request): {
  type: string;
  description: string;
  fileUrl: string;
} {
  const source = parseDefinitionBody(req.body);

  if (
    !source.metadata ||
    typeof source.metadata !== "object" ||
    Array.isArray(source.metadata)
  ) {
    throw new HttpError(
      400,
      "Field 'metadata' is required and must be an object.",
    );
  }

  const metadata = source.metadata as Record<string, unknown>;
  const fileUrl = metadata.file_url;

  if (typeof fileUrl !== "string") {
    throw new HttpError(
      400,
      "Field 'metadata.file_url' is required and must be a string.",
    );
  }

  const type = parseSourceDefinitionType(source, metadata);

  return {
    type,
    description: parseDefinitionDescription(source),
    fileUrl,
  };
}

function parseSourceDefinitionType(
  source: Record<string, unknown>,
  metadata: Record<string, unknown>,
): string {
  const sourceType = source.type;

  if (typeof sourceType === "string") {
    return sourceType;
  }

  const metadataType = metadata.type;

  if (typeof metadataType === "string") {
    return metadataType;
  }

  throw new HttpError(400, "Field 'type' is required and must be a string.");
}

function parseDefinitionType(body: Record<string, unknown>): string {
  if (typeof body.type !== "string") {
    throw new HttpError(400, "Field 'type' is required and must be a string.");
  }

  return body.type;
}

function parseDefinitionDescription(body: Record<string, unknown>): string {
  if (body.description === undefined) {
    return "";
  }

  if (typeof body.description !== "string") {
    throw new HttpError(400, "Field 'description' must be a string.");
  }

  return body.description;
}

function parseDefinitionSort(raw: unknown): DefinitionSortField | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw !== "string") {
    throw new HttpError(400, "Field 'sort' must be a string.");
  }

  const normalized = raw.trim();

  if (normalized.length === 0) {
    return undefined;
  }

  if (normalized !== "type") {
    throw new HttpError(400, "Field 'sort' must be one of: type.");
  }

  return normalized as DefinitionSortField;
}

function parseDefinitionIdFilter(raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw !== "string") {
    throw new HttpError(400, "Field 'id' must be a string.");
  }

  const normalized = raw.trim();

  if (!normalized) {
    throw new HttpError(400, "Field 'id' must not be empty.");
  }

  return normalized;
}

function parseDefinitionId(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new HttpError(400, "Field 'definitionId' must be a string.");
  }

  return raw;
}

function parseDefinitionBody(rawBody: unknown): Record<string, unknown> {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    throw new HttpError(400, "Request body must be an object.");
  }

  return rawBody as Record<string, unknown>;
}

function parseQueryParam(raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw !== "string") {
    throw new HttpError(400, "Field 'query' must be a string.");
  }

  const normalized = raw.trim();

  return normalized.length > 0 ? normalized : undefined;
}

function getDefinitionService(req: Request): DefinitionService {
  const service = req.app.locals.definitionService as
    | DefinitionService
    | undefined;

  if (!service) {
    throw new Error("DefinitionService not configured in app.locals");
  }

  return service;
}
