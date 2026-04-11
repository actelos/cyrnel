import type { Request, Response } from "express";

import { HttpError } from "@/models/error.model";
import type { ManifestService } from "@/services/manifest.service";

export async function listTools(req: Request, res: Response): Promise<void> {
  const manifestService = getManifestService(req);
  const toolName = parseToolNameFilter(req.query.name);
  const tools = await manifestService.listTools(toolName);

  res.status(200).json({ tools });
}

function parseToolNameFilter(raw: unknown): string | undefined {
  if (typeof raw === "undefined") {
    return undefined;
  }

  if (typeof raw !== "string") {
    throw new HttpError(400, "Query param 'name' must be a string.");
  }

  return raw;
}

function getManifestService(req: Request): ManifestService {
  const service = req.app.locals.manifestService as ManifestService | undefined;

  if (!service) {
    throw new Error("ManifestService not configured in app.locals");
  }

  return service;
}
