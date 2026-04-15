export type JSONSchema = Record<string, unknown>;
export type ManifestMetadata = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  metadata: ManifestMetadata;
}

export interface ServiceManifest {
  name: string;
  metadata: ManifestMetadata;
  tools: ToolDefinition[];
}

export interface PublicToolDefinition {
  name: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
}

export interface ToolDefinitionResponse extends PublicToolDefinition {
  serviceName: string;
}

export interface ServiceManifestResponse {
  name: string;
  hash: string;
}

export interface ServiceManifestDetails {
  name: string;
  hash: string;
  metadata: ManifestMetadata;
}
