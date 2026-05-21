import type { AdapterModule, EnvironmentModule } from "@mci/sdk";

export type ModuleType = "environment" | "adapter";

export interface ModuleManifest {
  name: string;
  type: ModuleType;
  version: string;
  description: string;
}

export interface BuiltinModuleManifest extends ModuleManifest {
  isBuiltin: true;
}

export interface CustomModuleManifest extends ModuleManifest {
  isBuiltin: false;
  main: string;
}

export type ModuleFactory<
  TManifest extends BuiltinModuleManifest | CustomModuleManifest =
    | BuiltinModuleManifest
    | CustomModuleManifest,
  TModule extends AdapterModule | EnvironmentModule =
    | AdapterModule
    | EnvironmentModule,
> = {
  manifest: TManifest;
  instantiate(): TModule;
};

export type AnyModuleFactory = ModuleFactory;
