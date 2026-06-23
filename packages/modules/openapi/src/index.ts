import type {
  AdapterModule,
  InvokeInput,
  JSONSchema,
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

    return makeRequest({
      method: toolDomain.method,
      url,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: params.body,
      timeoutMs,
    });
  }
}

const CONFIG_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    defaultTimeoutMs: {
      type: "integer",
      default: 30000,
      minimum: 1,
      description: "Default request timeout in milliseconds for all services",
    },
  },
  additionalProperties: false,
};

const SECRETS_SCHEMA: JSONSchema = { type: "null" };

export const manifest = {
  id: "openapi",
  name: "OpenAPI Adapter",
  description: "Adapter for interacting with OpenAPI services",
  type: "adapter" as const,
  configSchema: CONFIG_SCHEMA,
  secretsSchema: SECRETS_SCHEMA,
};

export function instantiate(): AdapterModule {
  return new OpenapiAdapter();
}
