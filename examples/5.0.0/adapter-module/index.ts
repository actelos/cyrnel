import type {
  AdapterModule,
  ConfigProvider,
  InvokeInput,
  ModuleSetupContext,
  ModuleLogger,
  ServiceDefinition,
  ServiceRuntime,
} from "@cyrnel/sdk";

interface EndpointMetadata {
  method: "GET" | "POST";
  path: string;
}

type ServiceConfig = {
  baseUrl?: string;
};

type Service = ServiceRuntime<
  { baseUrl: string },
  EndpointMetadata,
  ServiceConfig
>;

async function readOptionalConfig(
  provider: ConfigProvider<Record<string, unknown>>,
  key: string,
): Promise<unknown> {
  try {
    return await provider.get(key);
  } catch (err) {
    if (err instanceof Error && err.name === "ProviderKeyNotConfigured") {
      return undefined;
    }
    throw err;
  }
}

class HttpAdapter implements AdapterModule {
  private services = new Map<string, Service>();
  private logger: ModuleLogger | null = null;

  async setup(context: ModuleSetupContext) {
    const config = context.config as ConfigProvider<Record<string, unknown>>;
    const rawPatterns = await readOptionalConfig(config, "redactionPatterns");
    const patterns = Array.isArray(rawPatterns)
      ? rawPatterns.filter((p): p is string => typeof p === "string")
      : [];
    this.logger = context.logger.redact(patterns).child({ phase: "setup" });
    this.logger?.info({ event: "adapter-ready" }, "Adapter initialized");
  }

  async teardown() {
    this.services.clear();
  }

  async generateService(input: string): Promise<ServiceDefinition> {
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
        method: "GET" | "POST";
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
        properties: {},
        additionalProperties: false,
      },
      schemes: {
        bearer: { type: "http", scheme: "bearer" },
      },
      security: [{ bearer: [] }],
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

  async hydrateService(service: Service): Promise<void> {
    this.services.set(service.id, service);
  }

  async dehydrateService(id: string): Promise<void> {
    this.services.delete(id);
  }

  async invoke(input: InvokeInput): Promise<unknown> {
    const logger = this.logger?.child({
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

    const { method, path } = tool.adapterDomain;
    const adapterDomain = svc.adapterDomain;
    const config = svc.config as ConfigProvider<Record<string, unknown>>;
    const configuredBaseUrl = await readOptionalConfig(config, "baseUrl");
    const baseUrl =
      (typeof configuredBaseUrl === "string" && configuredBaseUrl) ||
      adapterDomain.baseUrl;

    const url = new URL(path, baseUrl);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (svc.credentials) {
      const credential = await svc.credentials.getCredential("bearer");
      if (credential.type !== "bearer") {
        throw new Error(
          `Scheme 'bearer' resolved to '${credential.type}' credentials, expected a bearer token.`,
        );
      }
      headers["Authorization"] = `Bearer ${credential.token}`;
    }

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
