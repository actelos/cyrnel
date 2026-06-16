import type { ServiceDefinition, ToolDefinition } from "@cyrnel/sdk";
import type { Operation } from "fast-json-patch";

export interface ToolDefinitionRecord extends ToolDefinition {
  serviceId: string;
  enabled: boolean;
}

export interface ServiceDefinitionRecord extends ServiceDefinition {
  id: string;
  hash: string;
  source: string;
  adapter: string;
  enabled: boolean;
  orphaned: boolean;
  stale: boolean;
  tools: ToolDefinitionRecord[];
}

export interface ListServicesInput {
  query?: string;
  limit?: number;
  enabled?: boolean;
  adapter?: string;
  stale?: boolean;
}

export type ListServiceDefinitionResult = Omit<
  ServiceDefinitionRecord,
  | "hash"
  | "orphaned"
  | "source"
  | "tools"
  | "configSchema"
  | "secretsSchema"
  | "adapterDomain"
  | "definitionContent"
>;

export interface ListToolsInput {
  serviceId?: string;
  query?: string;
  limit?: number;
  enabled?: boolean;
}

export interface ListToolsResult
  extends Omit<
    ToolDefinitionRecord,
    "inputSchema" | "outputSchema" | "adapterDomain"
  > {
  effectivelyEnabled: boolean;
}

export type GetServiceDefinitionResult = Omit<
  ServiceDefinitionRecord,
  "tools" | "adapterDomain" | "definitionContent"
>;

export interface GetToolInput {
  serviceId: string;
  toolId: string;
}

export interface GetToolsResult
  extends Omit<ToolDefinitionRecord, "adapterDomain" | "serviceId"> {
  effectivelyEnabled: boolean;
}

export interface DirectInstallServiceInput {
  id: string;
  url: string;
  adapter: string;
}

export interface RegistryInstallServiceInput {
  source: string;
  adapter?: string;
  id?: string;
}

export interface PatchServiceSourceInput {
  id: string;
  url: string;
}

export interface SetServiceEnabledInput {
  id: string;
  enabled: boolean;
}

export interface SetToolEnablesInput {
  serviceId: string;
  toolId: string;
  enabled: boolean;
}

export interface PatchInput {
  id: string;
  patch: Operation[];
}
