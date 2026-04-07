export type JSONSchema = Record<string, unknown>;
export type ManifestMetadata = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  metadata: ManifestMetadata;
}

export interface ServiceManifest {
  metadata: ManifestMetadata;
  tools: ToolDefinition[];
}

export interface ManifestTool {
  tool: ToolDefinition;
  serviceMetadata: ManifestMetadata;
}
