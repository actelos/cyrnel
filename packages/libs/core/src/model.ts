export type ModuleType = "environment" | "adapter";

export interface ModuleManifest {
  name: string;
  version: string;
  description: string;
  type: ModuleType;
  main: string;
}

export interface LoadedManifest extends ModuleManifest {
  isBuiltin: boolean;
}

export interface ManifestFilter {
  query?: string;
  isBuiltin?: boolean;
  type?: ModuleType;
}

export type ModuleFactory<TModule = unknown> = {
  manifest: LoadedManifest;
  instantiate(): TModule;
};
