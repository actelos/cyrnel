import type {
  AdapterModule,
  InvokeInput,
  ModuleSetupContext,
  ServiceDefinition,
  ServiceState,
} from "@mci/sdk";

import { generateDefinition } from "./generateDefinition";

class OpenapiAdapter implements AdapterModule {
  private readonly services = new Map<string, ServiceState>();

  async setup(_context: ModuleSetupContext): Promise<void> {}

  async teardown(): Promise<void> {
    this.services.clear();
  }

  generateDefinition(input: string): Promise<ServiceDefinition> {
    return generateDefinition(input);
  }

  async hydrateService(state: ServiceState): Promise<void> {
    this.services.set(state.id, state);
  }

  async dehydrateService(id: string): Promise<void> {
    this.services.delete(id);
  }

  async invoke(_input: InvokeInput): Promise<unknown> {
    return { status: "200" };
  }
}

export const manifest = {
  name: "openapi",
  version: "1.0.0",
  description: "Adapter for interacting with OpenAPI services",
  type: "adapter" as const,
};

export function instantiate(): AdapterModule {
  return new OpenapiAdapter();
}
