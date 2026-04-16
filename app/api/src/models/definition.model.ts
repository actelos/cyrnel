export const DEFINITION_TYPES = ["foo"] as const;

export type DefinitionType = (typeof DEFINITION_TYPES)[number];

export interface DefinitionResponse {
  id: string;
  type: DefinitionType;
  description: string;
  hash: string;
}
