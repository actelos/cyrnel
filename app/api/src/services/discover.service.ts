import type {
  DiscoverRequest,
  DiscoverResponse,
} from "@/models/discover.model";
import { ManifestService } from "@/services/manifest.service";

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
    if (message.type === "tools.discover") {
      const tools = await manifestService.discoverTools(message.query);
      channel.send?.({
        type: "tools.response",
        requestId: message.requestId,
        tools,
      });
      return;
    }

    const services = await manifestService.discoverServices(message.query);
    channel.send?.({
      type: "services.response",
      requestId: message.requestId,
      services,
    });
  } catch (error) {
    channel.send?.({
      type: message.type === "tools.discover" ? "tools.error" : "services.error",
      requestId: message.requestId,
      message:
        error instanceof Error
          ? error.message
          : String(error ?? "Unknown error"),
    });
  }
}

function isDiscoverMessage(message: unknown): message is DiscoverRequest {
  if (!message || typeof message !== "object") {
    return false;
  }

  const candidate = message as Partial<DiscoverRequest>;

  return (
    (candidate.type === "tools.discover" ||
      candidate.type === "services.discover") &&
    typeof candidate.requestId === "string" &&
    candidate.requestId.length > 0 &&
    typeof candidate.query === "string"
  );
}
