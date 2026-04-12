import type {
  ServiceManifestResponse,
  ToolDefinitionResponse,
} from "@/models/manifest.model";

export interface DiscoverToolsRequest {
  type: "tools.discover";
  requestId: string;
  query: string;
}

export interface DiscoverServicesRequest {
  type: "services.discover";
  requestId: string;
  query: string;
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
