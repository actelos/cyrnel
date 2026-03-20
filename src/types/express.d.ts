import type { ServerState } from "@/state";
import type { ProcessService } from "@/services/process.service";

declare global {
  namespace Express {
    interface Locals {
      serverState: ServerState;
      processService: ProcessService;
    }
  }
}
