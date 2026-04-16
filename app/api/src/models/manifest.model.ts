export type JSONSchema = Record<string, unknown>;
export type ManifestMetadata = Record<string, unknown>;

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
  metadata: ManifestMetadata;
  tools: ToolDefinition[];
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
  description: string;
  hash: string;
  enabled: boolean;
}

export interface ServiceManifestDetails {
  name: string;
  description: string;
  hash: string;
  enabled: boolean;
  metadata: ManifestMetadata;
}
