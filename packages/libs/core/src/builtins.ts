import * as typescriptIvm from "@mci/typescript-ivm";
import type { BuiltinModuleManifest, ModuleFactory } from "@/model";

export const builtinModules: ModuleFactory<BuiltinModuleManifest>[] = [
  {
    manifest: { ...typescriptIvm.manifest, isBuiltin: true },
    instantiate: typescriptIvm.instantiate,
  },
];
