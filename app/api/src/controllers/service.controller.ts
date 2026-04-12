import type { Request, Response } from "express";

import { HttpError } from "@/models/error.model";
import type { ManifestService } from "@/services/manifest.service";

export async function listServices(req: Request, res: Response): Promise<void> {
  const manifestService = getManifestService(req);
  const services = await manifestService.listServices();

  res.status(200).json({ services });
}

export async function getService(req: Request, res: Response): Promise<void> {
  const manifestService = getManifestService(req);
  const serviceName = parseServiceName(req.params.serviceName);
  const service = await manifestService.getService(serviceName);

  res.status(200).json(service);
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

export async function updateService(
  req: Request,
  res: Response,
): Promise<void> {
  const manifestService = getManifestService(req);
  const serviceName = parseServiceName(req.params.serviceName);
  const definitionId = parseDefinitionId(req.body);

  const updated = await manifestService.updateService(
    serviceName,
    definitionId,
  );
  res.status(200).json({ name: serviceName, updated });
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

function getManifestService(req: Request): ManifestService {
  const service = req.app.locals.manifestService as ManifestService | undefined;

  if (!service) {
    throw new Error("ManifestService not configured in app.locals");
  }

  return service;
}
