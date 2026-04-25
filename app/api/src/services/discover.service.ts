import { z } from "zod";
import type {
  DiscoverRequest,
  DiscoverResponse,
} from "@/models/discover.model";
import { ManifestService } from "@/services/manifest.service";

const discoverMessageSchema = z.object({
  type: z.union([z.literal("discover.tools"), z.literal("discover.services")]),
  requestId: z.string().min(1),
  query: z.string(),
  limit: z.number().int().positive().optional(),
  enabled: z.boolean().nullable().optional(),
});

export interface DiscoverMessageChannel {
  on(event: "message", listener: (message: unknown) => void): this;
  off(event: "message", listener: (message: unknown) => void): this;
  send?: (message: DiscoverResponse) => boolean;
}

interface DiscoverMessageSystemOptions {
  manifestService?: Pick<ManifestService, "discoverServices" | "discoverTools">;
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
  manifestService: Pick<ManifestService, "discoverServices" | "discoverTools">,
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
  } catch (error) {
    channel.send?.({
      type:
        message.type === "discover.tools" ? "tools.error" : "services.error",
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
