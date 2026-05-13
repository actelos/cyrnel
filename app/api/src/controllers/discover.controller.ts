import type { Request, Response } from "express";
import { z } from "zod";

import type { ManifestService } from "@/services/manifest.service";
import { parseOrHttpError } from "@/utils/validation.util";

const discoverBodySchema = z.object({
  query: z
    .string({ error: "Field 'query' must be a string." })
    .transform((value) => value.trim())
    .optional(),
  limit: z
    .number({ error: "Field 'limit' must be a positive integer." })
    .int({ error: "Field 'limit' must be a positive integer." })
    .positive({ error: "Field 'limit' must be a positive integer." })
    .optional(),
  enabled: z
    .boolean({ error: "Field 'enabled' must be a boolean or null." })
    .nullable()
    .optional(),
});

export async function discoverTools(
  req: Request,
  res: Response,
): Promise<void> {
  const manifestService = getManifestService(req);
  const body = parseDiscoverBody(req.body);
  const query = body.query ?? "";
  const limit = body.limit;
  const enabled = body.enabled;

  const tools =
    enabled === undefined
      ? await manifestService.discoverTools(query, limit)
      : await manifestService.discoverTools(query, limit, enabled);

  res.status(200).json({ tools });
}

export async function discoverServices(
  req: Request,
  res: Response,
): Promise<void> {
  const manifestService = getManifestService(req);
  const body = parseDiscoverBody(req.body);
  const query = body.query ?? "";
  const limit = body.limit;
  const enabled = body.enabled;

  const services =
    enabled === undefined
      ? await manifestService.discoverServices(query, limit)
      : await manifestService.discoverServices(query, limit, enabled);

  res.status(200).json({ services });
}

function parseDiscoverBody(raw: unknown): z.infer<typeof discoverBodySchema> {
  return parseOrHttpError(
    discoverBodySchema,
    raw ?? {},
    "Request body must be an object.",
  );
}

function getManifestService(req: Request): ManifestService {
  const service = req.app.locals.manifestService as ManifestService | undefined;

  if (!service) {
    throw new Error("ManifestService not configured in app.locals");
  }

  return service;
}
