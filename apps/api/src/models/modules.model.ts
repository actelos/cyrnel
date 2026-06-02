export const MODULE_TYPES = ["adapter", "environment"] as const;

export type ModuleType = (typeof MODULE_TYPES)[number];

export interface ModuleManifestRecord {
  id: string;
  name: string;
  type: ModuleType;
  description: string;
  isBuiltin: boolean;
  enabled: boolean;
  orphaned: boolean;
}

export interface FilterModuleManifestInput {
  query?: string;
  type?: ModuleType;
  isBuiltin?: boolean;
  enabled?: boolean | null;
}

export interface GenerateDefinitionInput {
  adapter: string;
  definition: string;
}

export type ListModuleManifestResult = ModuleManifestRecord;

export type GetModuleManifestResult = ModuleManifestRecord;

export interface SetModuleEnabledInput {
  id: string;
  enabled: boolean;
}
