import type { ServiceDefinition, ToolDefinition } from "@mci/sdk";
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
  tools: ToolDefinitionRecord[];
}

export interface ListServicesInput {
  query?: string;
  limit?: number;
  enabled?: boolean;
}

export type ListServiceDefinitionResult = Omit<
  ServiceDefinitionRecord,
  "tools" | "configSchema" | "secretsSchema" | "adapterDomain"
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
  "tools" | "adapterDomain"
>;

export interface GetToolInput {
  serviceId: string;
  toolId: string;
}

export interface GetToolsResult
  extends Omit<ToolDefinitionRecord, "adapterDomain" | "serviceId"> {
  effectivelyEnabled: boolean;
}

export interface InstallServiceDefinitionInput {
  id: string;
  source: string;
  adapter: string;
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
