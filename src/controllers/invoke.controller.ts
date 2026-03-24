import type { Request, Response } from "express";

import { logger } from "@/logger";
import { HttpError } from "@/models/error";
import { executeAdapterTool } from "@/config/modules";
import { createAdapterToolPath, type ServerState } from "@/state";

export async function invokeTool(req: Request, res: Response): Promise<void> {
  if (!req.body || typeof req.body !== "object") {
    logger.warn("Invoke request rejected: body must be an object");
    throw new HttpError(400, "Request body must be an object.");
  }

  const adapterId = parseId(req.body.adapterId, "adapterId");
  const serviceId = parseId(req.body.serviceId, "serviceId");
  const toolId = parseId(req.body.toolId, "toolId");
  const input = (req.body as { input?: unknown }).input;
  const serverState = getServerState(req);
  const cataloguedService = serverState.modules.catalog.services.get(serviceId);

  if (!cataloguedService) {
    logger.warn({ serviceId }, "Invoke request failed: service not found");
    throw new HttpError(404, `Service \"${serviceId}\" not found.`);
  }

  if (cataloguedService.adapterId !== adapterId) {
    logger.warn(
      {
        adapterId,
        serviceId,
        expectedAdapterId: cataloguedService.adapterId,
      },
      "Invoke request failed: service belongs to different adapter",
    );
    throw new HttpError(
      409,
      `Service \"${serviceId}\" belongs to adapter \"${cataloguedService.adapterId}\", not \"${adapterId}\".`,
    );
  }

  const toolPath = createAdapterToolPath(adapterId, serviceId, toolId);
  const cataloguedTool = serverState.modules.catalog.tools.get(toolPath);

  if (!cataloguedTool) {
    logger.warn(
      {
        adapterId,
        serviceId,
        requestedToolId: toolId,
        availableToolIds: cataloguedService.service.tools.map(
          (candidate) => candidate.id,
        ),
      },
      "Invoke request failed: tool not found",
    );
    throw new HttpError(
      404,
      `Tool \"${toolId}\" not found for service \"${serviceId}\".`,
    );
  }

  try {
    const output = await executeAdapterTool(cataloguedTool.tool, input);

    logger.info(
      {
        adapterId,
        serviceId,
        toolId,
        toolPath,
        outputType: output === null ? "null" : typeof output,
      },
      "Adapter tool executed successfully",
    );

    res.status(200).json({ output });
  } catch (error) {
    const parseErrorTag =
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      (error as { _tag?: unknown })._tag;

    if (parseErrorTag === "ParseError") {
      logger.warn(
        {
          adapterId,
          serviceId,
          toolId,
          err: error,
        },
        "Adapter tool payload validation failed",
      );

      throw new HttpError(400, (error as Error).message);
    }

    logger.error(
      {
        err: error,
        adapterId,
        serviceId,
        toolId,
      },
      "Adapter tool execution failed",
    );
    throw error;
  }
}

function getServerState(req: Request): ServerState {
  const serverState = req.app.locals.serverState as ServerState | undefined;

  if (!serverState) {
    throw new Error("ServerState not configured in app.locals");
  }

  return serverState;
}

function parseId(
  raw: unknown,
  field: "adapterId" | "serviceId" | "toolId",
): string {
  if (typeof raw !== "string") {
    throw new HttpError(400, `Field '${field}' must be a string.`);
  }

  const normalized = raw.trim();

  if (normalized.length === 0) {
    throw new HttpError(400, `Field '${field}' must not be empty.`);
  }

  return normalized;
}
