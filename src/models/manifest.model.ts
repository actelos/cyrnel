export type JSONSchema = Record<string, unknown>;
export type ManifestMetadata = Record<string, unknown>;

export interface ManifestToolDefinition {
  name: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  metadata: ManifestMetadata;
}

export interface Manifest {
  metadata: ManifestMetadata;
  tools: ManifestToolDefinition[];
}

export interface ManifestTool {
  tool: ManifestToolDefinition;
  serviceMetadata: ManifestMetadata;
}
