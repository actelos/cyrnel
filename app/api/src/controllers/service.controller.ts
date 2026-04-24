import type { Request, Response } from "express";

import { HttpError } from "@/models/error.model";
import type { ServiceInstallRequest } from "@/models/manifest.model";
import type { ManifestService } from "@/services/manifest.service";

export async function listServices(req: Request, res: Response): Promise<void> {
  const manifestService = getManifestService(req);
  const query = parseQueryParam(req.query?.query);
  const services = await manifestService.listServices(query);

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
    metadata: service.metadata,
  });
}

export async function listTools(req: Request, res: Response): Promise<void> {
  const manifestService = getManifestService(req);
  const serviceName = parseServiceName(req.params.serviceName);
  const query = parseQueryParam(req.query?.query);
  const tools = await manifestService.listTools(serviceName, query);

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
  const payload = parseInstallServicePayload(req.body);
  const service = await manifestService.createService(payload);

  res.status(201).json(service);
}

export async function updateService(
  req: Request,
  res: Response,
): Promise<void> {
  const manifestService = getManifestService(req);
  const serviceName = parseServiceName(req.params.serviceName);

  const updated = await manifestService.updateService(serviceName);
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
  const serviceName = parseServiceName(req.params.serviceName);

  await manifestService.deleteService(serviceName);
  res.status(204).send();
}

function parseServiceName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new HttpError(400, "Field 'serviceName' must be a string.");
  }

  return raw;
}

function parseToolName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new HttpError(400, "Field 'toolName' must be a string.");
  }

  return raw;
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

function parseInstallServicePayload(rawBody: unknown): ServiceInstallRequest {
  if (!rawBody || typeof rawBody !== "object") {
    throw new HttpError(400, "Request body must be an object.");
  }

  const source = rawBody as {
    type?: unknown;
    source?: unknown;
  };

  if (typeof source.type !== "string") {
    throw new HttpError(400, "Field 'type' is required and must be a string.");
  }

  const normalizedType = source.type.trim();

  if (!normalizedType) {
    throw new HttpError(400, "Field 'type' must not be empty.");
  }

  const sourceUrl = parseInstallSource(source.source);

  return {
    type: normalizedType,
    source: sourceUrl,
  };
}

function parseInstallSource(rawSource: unknown): string {
  if (typeof rawSource === "string") {
    const normalized = rawSource.trim();

    if (!normalized) {
      throw new HttpError(400, "Field 'source' must not be empty.");
    }

    return normalized;
  }

  if (!rawSource || typeof rawSource !== "object" || Array.isArray(rawSource)) {
    throw new HttpError(
      400,
      "Field 'source' is required and must be a string or object.",
    );
  }

  const sourceObject = rawSource as {
    file_url?: unknown;
    metadata?: unknown;
  };

  if (typeof sourceObject.file_url === "string") {
    const normalized = sourceObject.file_url.trim();

    if (!normalized) {
      throw new HttpError(400, "Field 'source.file_url' must not be empty.");
    }

    return normalized;
  }

  const metadata = sourceObject.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new HttpError(
      400,
      "Field 'source.file_url' or 'source.metadata.file_url' is required.",
    );
  }

  const metadataFileUrl = (metadata as { file_url?: unknown }).file_url;
  if (typeof metadataFileUrl !== "string" || metadataFileUrl.trim() === "") {
    throw new HttpError(
      400,
      "Field 'source.file_url' or 'source.metadata.file_url' is required.",
    );
  }

  return metadataFileUrl.trim();
}

function parseEnabled(rawBody: unknown): boolean {
  if (!rawBody || typeof rawBody !== "object") {
    throw new HttpError(400, "Request body must be an object.");
  }

  const enabled = (rawBody as { enabled?: unknown }).enabled;

  if (typeof enabled !== "boolean") {
    throw new HttpError(400, "Field 'enabled' must be a boolean.");
  }

  return enabled;
}

function getManifestService(req: Request): ManifestService {
  const service = req.app.locals.manifestService as ManifestService | undefined;

  if (!service) {
    throw new Error("ManifestService not configured in app.locals");
  }

  return service;
}
