import type { EnvironmentPoolService } from "@/services/pool.service";
import type { ProcessService } from "@/services/process.service";

declare global {
  namespace Express {
    interface Locals {
      environmentPoolService: EnvironmentPoolService;
      processService: ProcessService;
    }
  }
}
