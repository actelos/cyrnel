import type { AdapterPoolService } from "@/services/adapter-pool.service";
import type { EnvironmentPoolService } from "@/services/environment-pool.service";
import type { ManifestService } from "@/services/manifest.service";
import type { ProcessService } from "@/services/process.service";

declare global {
  namespace Express {
    interface Locals {
      adapterPoolService: AdapterPoolService;
      environmentPoolService: EnvironmentPoolService;
      manifestService: ManifestService;
      processService: ProcessService;
    }
  }
}
