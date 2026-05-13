export type JSONSchema = Record<string, unknown>;
export type ManifestMetadata = Record<string, unknown>;

export type ServiceType = string;

export interface ServiceInstallRequest {
  type: ServiceType;
  source: string;
}

export interface ServiceToolDefinition {
  name: string;
  description: string;
  enabled: boolean;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  metadata: ManifestMetadata;
}

export interface ServiceManifestDefinition {
  name: string;
  description: string;
  enabled: boolean;
  configSchema: JSONSchema;
  secretsSchema: JSONSchema;
  metadata: ManifestMetadata;
  tools: ServiceToolDefinition[];
}

export interface StagedToolEntry {
  name: string;
}

export interface StagedServiceEntry {
  name: string;
  tools: StagedToolEntry[];
}

export interface ToolListItem {
  name: string;
  description: string;
  enabled: boolean;
}

export interface ToolDiscoverItem {
  serviceName: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface ToolDetails {
  name: string;
  description: string;
  enabled: boolean;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
}

export interface ServiceListItem {
  name: string;
  type: ServiceType;
  source: string;
  description: string;
  hash: string;
  enabled: boolean;
}

export interface ServiceDiscoverItem {
  name: string;
  description: string;
  enabled: boolean;
}

export interface ServiceDetails {
  name: string;
  type: ServiceType;
  source: string;
  description: string;
  hash: string;
  enabled: boolean;
  configSchema: JSONSchema;
  secretsSchema: JSONSchema;
}
