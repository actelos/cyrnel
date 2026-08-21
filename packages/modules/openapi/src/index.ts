import type {
  AdapterModule,
  InvokeInput,
  ModuleSetupContext,
  ServiceDefinition,
  ServiceState,
} from "@cyrnel/sdk";

import {
  buildAuthHeaders,
  buildQueryString,
  makeRequest,
  resolveServerUrl,
  substitutePathParams,
} from "./client";
import { generateDefinition } from "./generateDefinition";

class OpenapiAdapter implements AdapterModule {
  private readonly services = new Map<string, ServiceState>();
  private logger: ModuleSetupContext["logger"] | null = null;

  async setup(context: ModuleSetupContext): Promise<void> {
    const patterns =
      (context.config.redactionPatterns as string[] | undefined) ?? [];
    this.logger = context.logger.redact(patterns).child({
      phase: "adapter-setup",
    });
  }

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

  async invoke(input: InvokeInput): Promise<unknown> {
    const service = this.services.get(input.serviceId);
    if (!service) {
      throw new Error(
        `Service '${input.serviceId}' is not hydrated. Sync the service first.`,
      );
    }

    const toolState = service.tools[input.toolId];
    if (!toolState) {
      throw new Error(
        `Tool '${input.toolId}' not found in service '${input.serviceId}'.`,
      );
    }

    const toolDomain = toolState.adapterDomain as {
      path: string;
      method: string;
      security?: Array<Record<string, string[]>>;
    };
    const serviceDomain = service.adapterDomain as {
      servers: Array<{
        url: string;
        variables?: Record<
          string,
          { default: string; enum?: string[]; description?: string }
        >;
      }>;
      securitySchemes?: Record<string, unknown>;
    };

    const params = input.parameters as Record<string, Record<string, unknown>>;

    const baseUrl = resolveServerUrl(
      serviceDomain.servers ?? [],
      service.config,
    );
    const path = substitutePathParams(toolDomain.path, params.path);
    const qs = buildQueryString(params.query);
    const url = `${baseUrl.replace(/\/+$/, "")}${path}${qs}`;

    const headerParams = (params.headers ?? {}) as Record<string, string>;
    const authHeaders = buildAuthHeaders(
      service.secrets,
      serviceDomain.securitySchemes,
      toolDomain.security,
    );

    const headers: Record<string, string> = { ...headerParams, ...authHeaders };

    if (params.cookies && Object.keys(params.cookies).length > 0) {
      headers.Cookie = Object.entries(params.cookies)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join("; ");
    }

    const timeoutMs =
      typeof service.config.timeoutMs === "number"
        ? service.config.timeoutMs
        : 30000;

    const logger = this.logger?.child({
      phase: "adapter-invoke",
    });
    logger?.info(
      {
        event: "adapter-request",
        method: toolDomain.method,
        path: path,
        requestHeaders: headers,
      },
      "Sending adapter request",
    );

    const startedAt = Date.now();
    try {
      const result = await makeRequest({
        method: toolDomain.method,
        url,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body: params.body,
        timeoutMs,
      });

      logger?.info(
        {
          event: "adapter-response",
          statusCode: Number(result.status),
          durationMs: Date.now() - startedAt,
        },
        "Received adapter response",
      );

      return result;
    } catch (err) {
      logger?.error(
        {
          event: "adapter-response-failed",
          err,
          durationMs: Date.now() - startedAt,
        },
        "Adapter request failed",
      );
      throw err;
    }
  }
}

export default {
  configSchema: {
    type: "object",
    properties: {
      defaultTimeoutMs: {
        type: "integer",
        default: 30000,
        minimum: 1,
        description: "Default request timeout in milliseconds for all services",
      },
      redactionPatterns: {
        type: "array",
        items: { type: "string" },
        description:
          "Additional redaction path patterns merged with the host-enforced baseline for this module's logs",
      },
    },
    additionalProperties: false,
  },
  secretsSchema: { type: "null" },
  instantiate: () => new OpenapiAdapter(),
};
