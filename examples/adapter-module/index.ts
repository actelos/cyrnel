import type {
  AdapterModule,
  InvokeInput,
  ModuleSetupContext,
  ServiceDefinition,
  ServiceState,
} from "@cyrnel/sdk";

interface EndpointMetadata {
  method: "GET" | "POST";
  path: string;
}

class HttpAdapter implements AdapterModule {
  private services = new Map<string, ServiceState>();

  async setup(_context: ModuleSetupContext) {}

  async teardown() {
    this.services.clear();
  }

  async generateDefinition(input: string): Promise<ServiceDefinition> {
    const spec: {
      name: string;
      description: string;
      baseUrl: string;
      endpoints: {
        id: string;
        name: string;
        description: string;
        method: string;
        path: string;
        inputSchema: Record<string, unknown>;
        outputSchema: Record<string, unknown>;
      }[];
    } = JSON.parse(input);

    return {
      name: spec.name,
      description: spec.description,
      configSchema: {
        type: "object",
        properties: {
          baseUrl: {
            type: "string",
            description: "Base URL of the API",
          },
        },
        required: ["baseUrl"],
      },
      secretsSchema: {
        type: "object",
        properties: {
          apiKey: {
            type: "string",
            description: "Bearer token sent as Authorization header",
          },
        },
      },
      adapterDomain: { baseUrl: spec.baseUrl },
      tools: spec.endpoints.map((ep) => ({
        id: ep.id,
        name: ep.name,
        description: ep.description,
        inputSchema: ep.inputSchema,
        outputSchema: ep.outputSchema,
        adapterDomain: {
          method: ep.method,
          path: ep.path,
        } satisfies EndpointMetadata,
      })),
    };
  }

  async hydrateService(state: ServiceState): Promise<void> {
    this.services.set(state.id, state);
  }

  async dehydrateService(id: string): Promise<void> {
    this.services.delete(id);
  }

  async invoke(input: InvokeInput): Promise<unknown> {
    const svc = this.services.get(input.serviceId);
    if (!svc) throw new Error(`Service ${input.serviceId} not found`);

    const tool = svc.tools[input.toolId];
    if (!tool) throw new Error(`Tool ${input.toolId} not found`);

    const { method, path } = tool.adapterDomain as EndpointMetadata;
    const baseUrl = svc.adapterDomain.baseUrl as string;
    const apiKey = svc.secrets.apiKey as string | undefined;

    const url = new URL(path, baseUrl);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const res = await fetch(url, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(input.parameters) : undefined,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    return res.json();
  }
}

export function instantiate(): AdapterModule {
  return new HttpAdapter();
}
