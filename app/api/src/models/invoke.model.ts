import type { ManifestMetadata, ToolDefinition } from "@/models/manifest.model";

export interface InvokeRequest {
  type: "tool.invoke";
  requestId: string;
  serviceName: string;
  toolName: string;
  parameters: Record<string, unknown>;
}

export interface InvokeResponseMessage {
  type: "tool.response";
  requestId: string;
  output: unknown;
}

export interface InvokeErrorResponseMessage {
  type: "tool.error";
  requestId: string;
  message: string;
}

export type InvokeResponse = InvokeResponseMessage | InvokeErrorResponseMessage;

export interface ResolvedToolInvocation {
  tool: ToolDefinition;
  serviceMetadata: ManifestMetadata;
}
