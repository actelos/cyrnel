import { z } from "zod";

import type {
  DiscoverRequest,
  DiscoverResponse,
} from "@/models/discover.model";
import { ManifestService } from "@/services/manifest.service";

const discoverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("discover.tools"),
    requestId: z.string().min(1),
    query: z.string(),
    limit: z.number().int().positive().optional(),
    enabled: z.boolean().nullable().optional(),
  }),
  z.object({
    type: z.literal("discover.services"),
    requestId: z.string().min(1),
    query: z.string(),
    limit: z.number().int().positive().optional(),
    enabled: z.boolean().nullable().optional(),
  }),
  z.object({
    type: z.literal("discover.tool"),
    requestId: z.string().min(1),
    serviceName: z.string().min(1),
    toolName: z.string().min(1),
  }),
  z.object({
    type: z.literal("discover.service"),
    requestId: z.string().min(1),
    serviceName: z.string().min(1),
  }),
]);

export interface DiscoverMessageChannel {
  on(event: "message", listener: (message: unknown) => void): this;
  off(event: "message", listener: (message: unknown) => void): this;
  send?: (message: DiscoverResponse) => boolean;
}

interface DiscoverMessageSystemOptions {
  manifestService?: Pick<
    ManifestService,
    "discoverServices" | "discoverTools" | "getService" | "getTool"
  >;
}

export function createDiscoverMessageSystem(
  channel: DiscoverMessageChannel = process,
  options: DiscoverMessageSystemOptions = {},
): () => void {
  const manifestService = options.manifestService ?? new ManifestService();

  const onMessage = (message: unknown) => {
    void handleDiscoverMessage(channel, manifestService, message);
  };

  channel.on("message", onMessage);

  return () => {
    channel.off("message", onMessage);
  };
}

async function handleDiscoverMessage(
  channel: DiscoverMessageChannel,
  manifestService: Pick<
    ManifestService,
    "discoverServices" | "discoverTools" | "getService" | "getTool"
  >,
  message: unknown,
): Promise<void> {
  if (!isDiscoverMessage(message)) {
    return;
  }

  try {
    if (message.type === "discover.tools") {
      const tools =
        message.enabled === undefined
          ? await manifestService.discoverTools(message.query, message.limit)
          : await manifestService.discoverTools(
              message.query,
              message.limit,
              message.enabled,
            );
      channel.send?.({
        type: "tools.response",
        requestId: message.requestId,
        tools,
      });
      return;
    }

    if (message.type === "discover.services") {
      const services =
        message.enabled === undefined
          ? await manifestService.discoverServices(message.query, message.limit)
          : await manifestService.discoverServices(
              message.query,
              message.limit,
              message.enabled,
            );
      channel.send?.({
        type: "services.response",
        requestId: message.requestId,
        services,
      });
      return;
    }

    if (message.type === "discover.tool") {
      const tool = await manifestService.getTool(
        message.serviceName,
        message.toolName,
      );
      channel.send?.({
        type: "tool.response",
        requestId: message.requestId,
        tool: tool.tool,
        serviceName: message.serviceName,
        serviceEnabled: tool.serviceEnabled,
        serviceMetadata: tool.serviceMetadata,
      });
      return;
    }

    const service = await manifestService.getService(message.serviceName);
    channel.send?.({
      type: "service.response",
      requestId: message.requestId,
      service,
    });
  } catch (error) {
    const errorType = (() => {
      switch (message.type) {
        case "discover.tools":
          return "tools.error";
        case "discover.services":
          return "services.error";
        case "discover.tool":
          return "tool.error";
        default:
          return "service.error";
      }
    })();
    channel.send?.({
      type: errorType,
      requestId: message.requestId,
      message:
        error instanceof Error
          ? error.message
          : String(error ?? "Unknown error"),
    });
  }
}

function isDiscoverMessage(message: unknown): message is DiscoverRequest {
  return discoverMessageSchema.safeParse(message).success;
}
