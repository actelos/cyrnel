import type { Request, Response } from "express";
import { z } from "zod";

import type { ServicesService } from "@/services/services.service";
import { paginationQuerySchema } from "@/utils/pagination.util";
import { parseOrHttpError } from "@/utils/validation.util";

const serviceIdSchema = z.string({
  error: "Field 'serviceId' must be a string.",
});

const toolIdSchema = z.string({
  error: "Field 'toolId' must be a string.",
});

const enabledBodySchema = z.object({
  enabled: z.boolean({ error: "Field 'enabled' must be a boolean." }),
});

const listToolsQuerySchema = paginationQuerySchema.merge(
  z.object({
    serviceId: z
      .string({ error: "Query param 'serviceId' must be a string." })
      .transform((value) => value.trim())
      .transform((value) => (value.length > 0 ? value : undefined))
      .optional(),
    query: z
      .string({ error: "Query param 'query' must be a string." })
      .transform((value) => value.trim())
      .transform((value) => (value.length > 0 ? value : undefined))
      .optional(),
    enabled: z
      .enum(["true", "false"], {
        error: "Query param 'enabled' must be 'true' or 'false'.",
      })
      .transform((value) => value === "true")
      .optional(),
  }),
);

export async function listTools(req: Request, res: Response): Promise<void> {
  const servicesService = getServicesService(req);
  const params = parseOrHttpError(
    listToolsQuerySchema,
    req.query ?? {},
    "Query parameters must be an object.",
  );

  const result = await servicesService.listTools(params);
  res.status(200).json(result);
}

export async function getTool(req: Request, res: Response): Promise<void> {
  const servicesService = getServicesService(req);
  const serviceId = parseOrHttpError(serviceIdSchema, req.params.serviceId);
  const toolId = parseOrHttpError(toolIdSchema, req.params.toolId);

  const tool = await servicesService.getTool({ serviceId, toolId });
  res.status(200).json(tool);
}

export async function getToolDocs(req: Request, res: Response): Promise<void> {
  const servicesService = getServicesService(req);
  const serviceId = parseOrHttpError(serviceIdSchema, req.params.serviceId);
  const toolId = parseOrHttpError(toolIdSchema, req.params.toolId);

  const docs = await servicesService.getToolDocs({ serviceId, toolId });
  res.status(200).type("text/markdown; charset=utf-8").send(docs);
}

export async function setToolEnabled(
  req: Request,
  res: Response,
): Promise<void> {
  const servicesService = getServicesService(req);
  const serviceId = parseOrHttpError(serviceIdSchema, req.params.serviceId);
  const toolId = parseOrHttpError(toolIdSchema, req.params.toolId);
  const { enabled } = parseOrHttpError(
    enabledBodySchema,
    req.body,
    "Request body must be an object.",
  );

  await servicesService.setToolEnabled({ serviceId, toolId, enabled });
  res.status(200).json({ id: toolId, serviceId, enabled });
}

function getServicesService(req: Request): ServicesService {
  const service = req.app.locals.servicesService as ServicesService | undefined;

  if (!service) {
    throw new Error("ServicesService not configured in app.locals");
  }

  return service;
}
