import type { Request, Response } from "express";

import { logger } from "@/logger";
import { HttpError } from "@/models/error";
import type { ServerState } from "@/state";
import { executeAdapterTool, type AdapterService } from "@/config/modules";

export async function invokeTool(req: Request, res: Response): Promise<void> {
  if (!req.body || typeof req.body !== "object") {
    logger.warn("Invoke request rejected: body must be an object");
    throw new HttpError(400, "Request body must be an object.");
  }

  const serviceId = parseId(req.body.serviceId, "serviceId");
  const toolId = parseId(req.body.toolId, "toolId");
  const input = (req.body as { input?: unknown }).input;
  const serverState = getServerState(req);
  const service = await findServiceById(serverState, serviceId);

  if (!service) {
    logger.warn({ serviceId }, "Invoke request failed: service not found");
    throw new HttpError(404, `Service \"${serviceId}\" not found.`);
  }

  const tool = service.tools.find((candidate) => candidate.id === toolId);

  if (!tool) {
    logger.warn(
      {
        serviceId,
        requestedToolId: toolId,
        availableToolIds: service.tools.map((candidate) => candidate.id),
      },
      "Invoke request failed: tool not found",
    );
    throw new HttpError(
      404,
      `Tool \"${toolId}\" not found for service \"${serviceId}\".`,
    );
  }

  try {
    const output = await executeAdapterTool(tool, input);

    logger.info(
      { serviceId, toolId, outputType: output === null ? "null" : typeof output },
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
          serviceId,
          toolId,
          err: error,
        },
        "Adapter tool input validation failed",
      );

      throw new HttpError(400, (error as Error).message);
    }

    logger.error(
      {
        err: error,
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

async function findServiceById(
  serverState: ServerState,
  serviceId: string,
): Promise<AdapterService | null> {
  for (const [moduleId, adapterModule] of serverState.modules.loaded.adapter.entries()) {
    const service = await adapterModule.parse();

    if (service.id === serviceId) {
      return service;
    }
  }

  return null;
}

function parseId(raw: unknown, field: "serviceId" | "toolId"): string {
  if (typeof raw !== "string") {
    throw new HttpError(400, `Field '${field}' must be a string.`);
  }

  const normalized = raw.trim();

  if (normalized.length === 0) {
    throw new HttpError(400, `Field '${field}' must not be empty.`);
  }

  return normalized;
}