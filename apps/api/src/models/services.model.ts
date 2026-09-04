import type { ServiceDefinition, ToolDefinition } from "@cyrnel/sdk";
import type { Operation } from "fast-json-patch";
import type { ToolPolicyDecision } from "@/models/tool-policies.model";

export interface ToolDefinitionRecord extends ToolDefinition {
  serviceId: string;
  enabled: boolean;
  summary: string;
}

export interface ServiceDefinitionRecord extends ServiceDefinition {
  id: string;
  hash: string;
  version: string;
  source: string;
  adapter: string;
  enabled: boolean;
  stale: boolean;
  tools: ToolDefinitionRecord[];
  summary: string;
}

export interface ListServicesInput {
  query?: string;
  limit?: number;
  cursor?: string;
  enabled?: boolean;
  adapter?: string;
  stale?: boolean;
}

export type ListServiceDefinitionResult = Omit<
  ServiceDefinitionRecord,
  | "hash"
  | "source"
  | "tools"
  | "configSchema"
  | "secretsSchema"
  | "adapterDomain"
  | "definitionContent"
> & { createdAt: string; effectivelyEnabled: boolean; hasIcon: boolean };

export interface ListToolsInput {
  serviceId?: string;
  query?: string;
  limit?: number;
  cursor?: string;
  enabled?: boolean;
  decision?: ToolPolicyDecision;
}

export interface ListToolsResult
  extends Omit<
    ToolDefinitionRecord,
    "inputSchema" | "outputSchema" | "adapterDomain"
  > {
  effectivelyEnabled: boolean;
  policy?: { decision: ToolPolicyDecision; updatedAt: number | null };
  score?: number;
  matchType?: "fts" | "vector" | "both";
  ftsRank?: number;
  vectorRank?: number;
}

export type GetServiceDefinitionResult = Omit<
  ServiceDefinitionRecord,
  "tools" | "adapterDomain" | "definitionContent"
> & { effectivelyEnabled: boolean; hasIcon: boolean };

export interface GetToolInput {
  serviceId: string;
  toolId: string;
}

export interface GetToolsResult
  extends Omit<ToolDefinitionRecord, "adapterDomain" | "serviceId"> {
  effectivelyEnabled: boolean;
  policy?: { decision: ToolPolicyDecision; updatedAt: number | null };
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
  version?: string;
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

export interface ServiceConfigView {
  config: Record<string, unknown>;
  outdated: string[];
}

export interface SecretsPresence {
  present: string[];
  outdated: string[];
}
