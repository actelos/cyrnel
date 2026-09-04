import type { ProcessService } from "@/services/process.service";

let current: ProcessService | null = null;

export function setProcessService(service: ProcessService): void {
  current = service;
}

export function getProcessService(): ProcessService | null {
  return current;
}
