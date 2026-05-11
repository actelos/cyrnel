export type JSONSchema = Record<string, unknown>;
export type ManifestMetadata = Record<string, unknown>;

export type ServiceType = string;

export interface ServiceInstallRequest {
  type: ServiceType;
  source: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  enabled: boolean;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  metadata: ManifestMetadata;
}

export interface ServiceManifest {
  name: string;
  description: string;
  enabled: boolean;
  configSchema: JSONSchema;
  secretsSchema: JSONSchema;
  metadata: ManifestMetadata;
  tools: ToolDefinition[];
}

export interface StagedToolManifest {
  name: string;
}

export interface StagedServiceManifest {
  name: string;
  tools: StagedToolManifest[];
}

export interface PublicToolDefinition {
  name: string;
  description: string;
  enabled: boolean;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
}

export interface ToolDefinitionResponse extends PublicToolDefinition {
  serviceName: string;
  serviceDescription: string;
}

export interface ServiceManifestResponse {
  name: string;
  type: ServiceType;
  source: string;
  description: string;
  hash: string;
  enabled: boolean;
}

export interface ServiceManifestDetails {
  name: string;
  type: ServiceType;
  source: string;
  description: string;
  hash: string;
  enabled: boolean;
  configSchema: JSONSchema;
  secretsSchema: JSONSchema;
  metadata: ManifestMetadata;
}
