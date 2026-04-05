export type JSONSchema = Record<string, unknown>;

export interface ManifestTool {
  name: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
}
