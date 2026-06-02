import type { ModuleService } from "@/services/modules.service";
import type { ProcessService } from "@/services/process.service";
import type { ServicesService } from "@/services/services.service";

declare global {
  namespace Express {
    interface Locals {
      moduleService: ModuleService;
      processService: ProcessService;
      servicesService: ServicesService;
    }
  }
}
