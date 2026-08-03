import type { JSONSchema } from "@cyrnel/sdk";
import type { Operation } from "fast-json-patch";
import { valid } from "semver";
import { z } from "zod";

export const MODULE_TYPES = ["adapter", "environment"] as const;

export type ModuleType = (typeof MODULE_TYPES)[number];

export interface ModuleManifestRecord {
  id: string;
  name: string;
  type: ModuleType;
  description: string;
  hash: string;
  version: string;
  source: string;
  isBuiltin: boolean;
  enabled: boolean;
  missing: boolean;
  configSchema: JSONSchema;
  secretsSchema: JSONSchema;
}

export interface FilterModuleManifestInput {
  query?: string;
  type?: ModuleType;
  isBuiltin?: boolean;
  enabled?: boolean;
  missing?: boolean;
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

export interface ModuleConfigView {
  config: Record<string, unknown> | null;
  outdated: string[];
}

export interface ModuleSecretsPresence {
  present: string[];
  outdated: string[];
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
  version?: string;
}

export const moduleManifestSchema = z.object({
  id: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$-]*$/),
  name: z.string().min(1),
  version: z.string().refine((value) => valid(value) !== null, {
    message: "Module manifest version must be a valid semver version.",
  }),
  description: z.string(),
  type: z.enum(MODULE_TYPES),
  main: z.string().min(1),
  engines: z
    .object({
      cyrnel: z.string().min(1),
    })
    .optional(),
});

export type ModuleManifestSchema = z.infer<typeof moduleManifestSchema>;
