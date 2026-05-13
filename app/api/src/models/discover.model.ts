import type {
  ManifestMetadata,
  ServiceDetails,
  ServiceListItem,
  ServiceToolDefinition,
  ToolDiscoverItem,
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

export interface DiscoverToolRequest {
  type: "discover.tool";
  requestId: string;
  serviceName: string;
  toolName: string;
}

export interface DiscoverServiceRequest {
  type: "discover.service";
  requestId: string;
  serviceName: string;
}

export type DiscoverRequest =
  | DiscoverToolsRequest
  | DiscoverServicesRequest
  | DiscoverToolRequest
  | DiscoverServiceRequest;

export interface DiscoverToolsResponse {
  type: "tools.response";
  requestId: string;
  tools: ToolDiscoverItem[];
}

export interface DiscoverServicesResponse {
  type: "services.response";
  requestId: string;
  services: ServiceListItem[];
}

export interface DiscoverToolResponse {
  type: "tool.response";
  requestId: string;
  tool: ServiceToolDefinition;
  serviceName: string;
  serviceEnabled: boolean;
  serviceMetadata: ManifestMetadata;
}

export interface DiscoverServiceResponse {
  type: "service.response";
  requestId: string;
  service: ServiceDetails;
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

export interface DiscoverToolErrorResponse {
  type: "tool.error";
  requestId: string;
  message: string;
}

export interface DiscoverServiceErrorResponse {
  type: "service.error";
  requestId: string;
  message: string;
}

export type DiscoverResponse =
  | DiscoverToolsResponse
  | DiscoverServicesResponse
  | DiscoverToolResponse
  | DiscoverServiceResponse
  | DiscoverToolsErrorResponse
  | DiscoverServicesErrorResponse
  | DiscoverToolErrorResponse
  | DiscoverServiceErrorResponse;
