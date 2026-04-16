import type {
  ServiceManifestResponse,
  ToolDefinitionResponse,
} from "@/models/manifest.model";

export interface DiscoverToolsRequest {
  type: "discover.tools";
  requestId: string;
  query: string;
  limit?: number;
  enabled?: boolean | null;
}

export interface DiscoverServicesRequest {
  type: "discover.services";
  requestId: string;
  query: string;
  limit?: number;
  enabled?: boolean | null;
}

export type DiscoverRequest = DiscoverToolsRequest | DiscoverServicesRequest;

export interface DiscoverToolsResponse {
  type: "tools.response";
  requestId: string;
  tools: ToolDefinitionResponse[];
}

export interface DiscoverServicesResponse {
  type: "services.response";
  requestId: string;
  services: ServiceManifestResponse[];
}

export interface DiscoverToolsErrorResponse {
  type: "tools.error";
  requestId: string;
  message: string;
}

export interface DiscoverServicesErrorResponse {
  type: "services.error";
  requestId: string;
  message: string;
}

export type DiscoverResponse =
  | DiscoverToolsResponse
  | DiscoverServicesResponse
  | DiscoverToolsErrorResponse
  | DiscoverServicesErrorResponse;
