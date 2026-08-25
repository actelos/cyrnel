import type { JSONSchema } from "@cyrnel/sdk";
import type { Operation } from "fast-json-patch";
import { valid, validRange } from "semver";
import { z } from "zod";

export const MODULE_TYPES = ["adapter", "environment"] as const;

export type ModuleType = (typeof MODULE_TYPES)[number];

const moduleCompatibilityEntrySchema = z.object({
  identifier: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  version: z.string().refine((value) => validRange(value) !== null, {
    message:
      "Compatibility version must be a valid semver range, e.g. '>=3.0 <4.0'.",
  }),
});

export const moduleCompatibilitySchema = z
  .array(moduleCompatibilityEntrySchema)
  .min(1)
  .optional();

export interface ModuleManifestRecord {
  id: string;
  name: string;
  type: ModuleType;
  summary: string;
  description: string;
  hash: string;
  version: string;
  source: string;
  isBuiltin: boolean;
  enabled: boolean;
  missing: boolean;
  hasIcon: boolean;
  compatibility?: { identifier: string; version: string }[];
  configSchema: JSONSchema;
  secretsSchema: JSONSchema;
}

export interface FilterModuleManifestInput {
  query?: string;
  type?: ModuleType;
  isBuiltin?: boolean;
  enabled?: boolean;
  missing?: boolean;
  limit?: number;
  cursor?: string;
}

export interface GenerateDefinitionInput {
  adapter: string;
  definition: string;
}

export interface RankedAdapter {
  id: string;
  name: string;
  compatible: boolean;
  active: boolean;
  isBuiltin: boolean;
}

export type ListModuleManifestResult = Omit<
  ModuleManifestRecord,
  "configSchema" | "secretsSchema" | "hash" | "source"
> & { createdAt: string };

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
  summary: z.string().optional(),
  description: z.string(),
  type: z.enum(MODULE_TYPES),
  main: z.string().min(1),
  compatibility: moduleCompatibilitySchema,
  engines: z
    .object({
      cyrnel: z.string().min(1),
    })
    .optional(),
});

export type ModuleManifestSchema = z.infer<typeof moduleManifestSchema>;
