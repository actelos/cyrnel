import type { Request, Response } from "express";

import { HttpError } from "@/models/error.model";
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
  const serviceName = parseServiceName(req.params.serviceName);
  const definitionId = parseDefinitionId(req.body);

  await manifestService.createService(serviceName, definitionId);
  res.status(201).json({ name: serviceName });
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

function parseDefinitionId(rawBody: unknown): string {
  if (!rawBody || typeof rawBody !== "object") {
    throw new HttpError(400, "Request body must be an object.");
  }

  const definitionId = (rawBody as { definitionId?: unknown }).definitionId;

  if (typeof definitionId !== "string") {
    throw new HttpError(400, "Field 'definitionId' must be a string.");
  }

  return definitionId;
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
