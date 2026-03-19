import type { ServerState } from "@/state";

declare global {
  namespace Express {
    interface Locals {
      serverState: ServerState;
    }
  }
}
