import { ParseResult } from "effect";

import { logger } from "@/logger";
import { HttpError } from "@/models/error";
import type { ProcessMessage, ProcessMessageResponse } from "@/models/process";
import { executeAdapterTool } from "@/config/modules";
import { createAdapterToolPath, type ServerState } from "@/state";

export type InvokeHandler = (
  message: ProcessMessage,
) => Promise<ProcessMessageResponse>;

type AdapterToolParseStage = "input" | "output";

const ADAPTER_TOOL_PARSE_STAGE_KEY = "mciParseStage";

export const createInvokeHandler = (serverState: ServerState): InvokeHandler => {
  return async (message) => {
    if (message.type !== "tool.invoke") {
      return createErrorResponse(message, "Unsupported process message type.");
    }

    try {
      const adapterId = parseId(message.adapterId, "adapterId");
      const serviceId = parseId(message.serviceId, "serviceId");
      const toolId = parseId(message.toolId, "toolId");
      const cataloguedService =
        serverState.modules.catalog.services.get(serviceId);

      if (!cataloguedService) {
        logger.warn(
          { serviceId },
          "Invoke failed: service not found",
        );
        throw new HttpError(404, `Service "${serviceId}" not found.`);
      }

      if (cataloguedService.adapterId !== adapterId) {
        logger.warn(
          {
            adapterId,
            serviceId,
            expectedAdapterId: cataloguedService.adapterId,
          },
          "Invoke failed: service belongs to different adapter",
        );
        throw new HttpError(
          409,
          `Service "${serviceId}" belongs to adapter "${cataloguedService.adapterId}", not "${adapterId}".`,
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
          "Invoke failed: tool not found",
        );
        throw new HttpError(
          404,
          `Tool "${toolId}" not found for service "${serviceId}".`,
        );
      }

      const output = await executeAdapterTool(cataloguedTool.tool, message.input);

      logger.info(
        {
          adapterId,
          serviceId,
          toolId,
          toolPath,
          outputType: output === null ? "null" : typeof output,
        },
        "Adapter tool executed from invoke",
      );

      return {
        type: "tool.response",
        requestId: message.requestId,
        output,
      };
    } catch (error) {
      if (ParseResult.isParseError(error)) {
        const parseStage = getAdapterToolParseStage(error);

        if (parseStage === "input") {
          logger.warn(
            {
              adapterId: message.adapterId,
              serviceId: message.serviceId,
              toolId: message.toolId,
              parseStage,
              err: error,
            },
            "Adapter tool input validation failed",
          );

          return createErrorResponse(
            message,
            (error as Error).message,
            400,
          );
        }

        if (parseStage === "output") {
          logger.warn(
            {
              adapterId: message.adapterId,
              serviceId: message.serviceId,
              toolId: message.toolId,
              parseStage,
              err: error,
            },
            "Adapter tool output validation failed",
          );

          return createErrorResponse(
            message,
            "Adapter tool output did not match its declared schema.",
            502,
          );
        }

        logger.warn(
          {
            adapterId: message.adapterId,
            serviceId: message.serviceId,
            toolId: message.toolId,
            parseStage,
            err: error,
          },
          "Adapter tool parse error without stage metadata",
        );

        return createErrorResponse(message, (error as Error).message);
      }

      if (error instanceof HttpError) {
        return createErrorResponse(message, error.message, error.statusCode);
      }

      logger.error(
        {
          err: error,
          adapterId: message.adapterId,
          serviceId: message.serviceId,
          toolId: message.toolId,
        },
        "Adapter tool execution failed",
      );

      const messageText =
        error instanceof Error ? error.message : String(error ?? "Unknown error");

      return createErrorResponse(message, messageText);
    }
  };
};

const parseId = (
  raw: unknown,
  field: "adapterId" | "serviceId" | "toolId",
): string => {
  if (typeof raw !== "string") {
    throw new HttpError(400, `Field '${field}' must be a string.`);
  }

  const normalized = raw.trim();

  if (normalized.length === 0) {
    throw new HttpError(400, `Field '${field}' must not be empty.`);
  }

  if (normalized.includes(".")) {
    throw new HttpError(400, `Field '${field}' must not contain '.'.`);
  }

  return normalized;
};

const getAdapterToolParseStage = (
  error: unknown,
): AdapterToolParseStage | undefined => {
  if (!ParseResult.isParseError(error) || !error || typeof error !== "object") {
    return undefined;
  }

  const parseStage = Reflect.get(error as object, ADAPTER_TOOL_PARSE_STAGE_KEY);

  return parseStage === "input" || parseStage === "output"
    ? parseStage
    : undefined;
};

const createErrorResponse = (
  message: ProcessMessage,
  errorMessage: string,
  statusCode?: number,
): ProcessMessageResponse => ({
  type: "tool.error",
  requestId: message.requestId,
  error: {
    message: errorMessage,
    ...(statusCode !== undefined ? { statusCode } : {}),
  },
});
