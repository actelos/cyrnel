import type {
  ManifestMetadata,
  ServiceToolDefinition,
} from "@/models/manifest.model";

export interface InvokeRequest {
  type: "invoke.tool";
  requestId: string;
  serviceName: string;
  toolName: string;
  parameters: Record<string, unknown>;
}

export interface InvokeResponseMessage {
  type: "invoke.response";
  requestId: string;
  output: unknown;
}

export interface InvokeErrorResponseMessage {
  type: "invoke.error";
  requestId: string;
  message: string;
}

export type InvokeResponse = InvokeResponseMessage | InvokeErrorResponseMessage;

export interface ResolvedToolInvocation {
  tool: ServiceToolDefinition;
  serviceMetadata: ManifestMetadata;
  serviceEnabled: boolean;
}
