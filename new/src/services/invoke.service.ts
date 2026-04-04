import type {
  InvokeMessage,
  InvokeMessageResponse,
} from "@/models/invoke.model";
import type { AdapterModule } from "@/modules/adapter.module";

export interface ProcessMessageChannel {
  on(event: "message", listener: (message: unknown) => void): this;
  off(event: "message", listener: (message: unknown) => void): this;
  send?: (message: InvokeMessageResponse) => boolean;
}

export function createProcessMessageSystem(
  adapterModule: AdapterModule,
  channel: ProcessMessageChannel = process,
): () => void {
  const onMessage = (message: unknown) => {
    void handleInvokeMessage(adapterModule, channel, message);
  };

  channel.on("message", onMessage);

  return () => {
    channel.off("message", onMessage);
  };
}

async function handleInvokeMessage(
  adapterModule: AdapterModule,
  channel: ProcessMessageChannel,
  message: unknown,
): Promise<void> {
  if (!isProcessInvokeMessage(message)) {
    return;
  }

  try {
    const output = await adapterModule.invoke(
      message.serviceId,
      message.toolId,
      message.parameters,
    );

    channel.send?.({
      type: "process.response",
      requestId: message.requestId,
      output,
    });
  } catch (error) {
    channel.send?.({
      type: "process.error",
      requestId: message.requestId,
      error: {
        message:
          error instanceof Error
            ? error.message
            : String(error ?? "Unknown error"),
      },
    });
  }
}

function isProcessInvokeMessage(message: unknown): message is InvokeMessage {
  if (!message || typeof message !== "object") {
    return false;
  }

  const candidate = message as Partial<InvokeMessage>;

  return (
    candidate.type === "process.invoke" &&
    typeof candidate.requestId === "string" &&
    candidate.requestId.length > 0 &&
    typeof candidate.serviceId === "string" &&
    candidate.serviceId.length > 0 &&
    typeof candidate.toolId === "string" &&
    candidate.toolId.length > 0 &&
    !!candidate.parameters &&
    typeof candidate.parameters === "object" &&
    !Array.isArray(candidate.parameters)
  );
}
