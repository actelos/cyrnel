import type { ManifestMetadata, ToolDefinition } from "@/models/manifest.model";

export interface InvokeRequestMessage {
  type: "tool.invoke";
  requestId: string;
  serviceName: string;
  toolName: string;
  parameters: Record<string, unknown>;
}

export type InvokeMessage = InvokeRequestMessage;

export interface InvokeResponseMessage {
  type: "tool.response";
  requestId: string;
  output: unknown;
}

export interface InvokeErrorResponseMessage {
  type: "tool.error";
  requestId: string;
  error: {
    message: string;
  };
}

export type InvokeMessageResponse = InvokeResponseMessage | InvokeErrorResponseMessage;

export interface ResolvedToolInvocation {
  tool: ToolDefinition;
  serviceMetadata: ManifestMetadata;
}
