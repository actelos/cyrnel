import type { JSONSchema } from "@cyrnel/sdk";
import type { Operation } from "fast-json-patch";
import { z } from "zod";

export const MODULE_TYPES = ["adapter", "environment"] as const;

export type ModuleType = (typeof MODULE_TYPES)[number];

export interface ModuleManifestRecord {
  id: string;
  name: string;
  type: ModuleType;
  description: string;
  hash: string;
  source: string;
  isBuiltin: boolean;
  enabled: boolean;
  orphaned: boolean;
  configSchema: JSONSchema;
  secretsSchema: JSONSchema;
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

export type ListModuleManifestResult = Omit<
  ModuleManifestRecord,
  "configSchema" | "secretsSchema" | "hash" | "source"
>;

export type GetModuleManifestResult = ModuleManifestRecord;

export interface SetModuleEnabledInput {
  id: string;
  enabled: boolean;
}

export interface PatchModuleConfigInput {
  id: string;
  patch: Operation[];
}

export interface PatchModuleSecretsInput {
  id: string;
  patch: Operation[];
}

export interface DirectInstallModuleInput {
  url: string;
}

export interface PatchModuleSourceInput {
  id: string;
  url: string;
}

export interface RegistryInstallModuleInput {
  source: string;
}

export const moduleManifestSchema = z.object({
  id: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$-]*$/),
  name: z.string().min(1),
  description: z.string(),
  type: z.enum(MODULE_TYPES),
  main: z.string().min(1),
  configSchema: z.record(z.string(), z.unknown()).optional(),
  secretsSchema: z.record(z.string(), z.unknown()).optional(),
});

export type ModuleManifestSchema = z.infer<typeof moduleManifestSchema>;
