import type { Request, Response } from "express";

import { HttpError } from "@/models/error.model";
import type { DefinitionService } from "@/services/definition.service";

export async function listDefinitions(
  req: Request,
  res: Response,
): Promise<void> {
  const definitionService = getDefinitionService(req);
  const definitions = await definitionService.listDefinitions();

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
  content: string;
} {
  const type = parseDefinitionType(req);
  const rawBody = req.body;

  if (!Buffer.isBuffer(rawBody)) {
    throw new HttpError(
      400,
      "Request body must be a definition file uploaded as binary data.",
    );
  }

  return {
    type,
    content: rawBody.toString("utf8"),
  };
}

function parseInstallDefinitionPayload(req: Request): {
  type: string;
  fileUrl: string;
} {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new HttpError(400, "Request body must be a source JSON object.");
  }

  const source = req.body as Record<string, unknown>;

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

  const type = parseSourceDefinitionType(source, metadata, req);

  return {
    type,
    fileUrl,
  };
}

function parseSourceDefinitionType(
  source: Record<string, unknown>,
  metadata: Record<string, unknown>,
  req: Request,
): string {
  const sourceType = source.type;

  if (typeof sourceType === "string") {
    return sourceType;
  }

  const metadataType = metadata.type;

  if (typeof metadataType === "string") {
    return metadataType;
  }

  return parseDefinitionType(req);
}

function parseDefinitionType(req: Request): string {
  const queryType = req.query.type;

  if (typeof queryType === "string") {
    return queryType;
  }

  const headerType = req.header("x-definition-type");

  if (typeof headerType === "string") {
    return headerType;
  }

  throw new HttpError(
    400,
    "Definition type is required as query param 'type' or header 'x-definition-type'.",
  );
}

function parseDefinitionId(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new HttpError(400, "Field 'definitionId' must be a string.");
  }

  return raw;
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
