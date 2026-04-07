import type { Request, Response } from "express";

import { HttpError } from "@/models/error.model";
import type { ManifestService } from "@/services/manifest.service";

export async function listTools(req: Request, res: Response): Promise<void> {
  const manifestService = getManifestService(req);
  const toolName = parseToolName(req.params.toolName);
  const tools = await manifestService.listToolsByName(toolName);

  res.status(200).json({ tools });
}

function parseToolName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new HttpError(400, "Field 'toolName' must be a string.");
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
