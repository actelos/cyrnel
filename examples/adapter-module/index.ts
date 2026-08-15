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
  private logger: ModuleSetupContext["logger"] | null = null;

  async setup(context: ModuleSetupContext) {
    const patterns =
      (context.config.redactionPatterns as string[] | undefined) ?? [];
    this.logger = context.logger.redact(patterns).child({ phase: "setup" });
    this.logger?.info({ event: "adapter-ready" }, "Adapter initialized");
  }

  async teardown() {
    this.services.clear();
  }

  async generateDefinition(input: string): Promise<ServiceDefinition> {
    const spec: {
      name: string;
      summary?: string;
      description: string;
      baseUrl: string;
      endpoints: {
        id: string;
        name: string;
        summary?: string;
        description: string;
        method: string;
        path: string;
        inputSchema: Record<string, unknown>;
        outputSchema: Record<string, unknown>;
      }[];
    } = JSON.parse(input);

    return {
      name: spec.name,
      summary: spec.summary,
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
        summary: ep.summary,
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
    const logger = this.logger?.child({
      serviceId: input.serviceId,
      toolId: input.toolId,
      phase: "invoke",
    });

    const svc = this.services.get(input.serviceId);
    if (!svc) {
      logger?.error(
        { event: "service-not-found", serviceId: input.serviceId },
        "Service not found",
      );
      throw new Error(`Service ${input.serviceId} not found`);
    }

    const tool = svc.tools[input.toolId];
    if (!tool) {
      logger?.error(
        { event: "tool-not-found", toolId: input.toolId },
        "Tool not found",
      );
      throw new Error(`Tool ${input.toolId} not found`);
    }

    const { method, path } = tool.adapterDomain as EndpointMetadata;
    const baseUrl = svc.adapterDomain.baseUrl as string;
    const apiKey = svc.secrets.apiKey as string | undefined;

    const url = new URL(path, baseUrl);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    logger?.info(
      { event: "request", method, path },
      "Forwarding request to upstream service",
    );

    const res = await fetch(url, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(input.parameters) : undefined,
    });

    if (!res.ok) {
      logger?.error(
        { event: "request-failed", status: res.status },
        `Upstream responded ${res.status}`,
      );
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    return res.json();
  }
}

export default {
  configSchema: {
    type: "object",
    properties: {
      redactionPatterns: {
        type: "array",
        items: { type: "string" },
        description:
          "Path patterns (dot/bracket notation) merged additively with the host-enforced baseline for this module's logs.",
      },
    },
    additionalProperties: false,
  },
  secretsSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  instantiate: (): AdapterModule => new HttpAdapter(),
};
