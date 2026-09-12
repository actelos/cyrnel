import type {
  AdapterModule,
  ConfigProvider,
  InvokeInput,
  ModuleLogger,
  ModuleSetupContext,
  SecurityRequirements,
  ServiceDefinition,
  ServiceRuntime,
} from "@cyrnel/sdk";

import {
  buildQueryString,
  makeRequest,
  readOptionalConfig,
  resolveAuthPlacements,
  resolveServerUrl,
  substitutePathParams,
} from "./client";
import { generateService } from "./generateDefinition";

type ServiceDomain = {
  servers: Array<{
    url: string;
    variables?: Record<
      string,
      { default: string; enum?: string[]; description?: string }
    >;
  }>;
  securitySchemes?: Record<string, unknown>;
};

type ToolDomain = {
  path: string;
  method: string;
  security?: Array<Record<string, string[]>>;
};

type Service = ServiceRuntime<
  ServiceDomain,
  ToolDomain,
  Record<string, unknown>
>;

class OpenapiAdapter implements AdapterModule {
  private readonly services = new Map<string, Service>();
  private logger: ModuleLogger | null = null;

  async setup(context: ModuleSetupContext): Promise<void> {
    const config = context.config as ConfigProvider<Record<string, unknown>>;
    const rawPatterns = await readOptionalConfig(config, "redactionPatterns");
    const patterns = Array.isArray(rawPatterns)
      ? rawPatterns.filter((p): p is string => typeof p === "string")
      : [];
    this.logger = context.logger.redact(patterns).child({
      phase: "adapter-setup",
    });
  }

  async teardown(): Promise<void> {
    this.services.clear();
  }

  generateService(input: string): Promise<ServiceDefinition> {
    return generateService(input);
  }

  async hydrateService(service: Service): Promise<void> {
    this.services.set(service.id, service);
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

    const toolDomain = toolState.adapterDomain as ToolDomain;
    const toolSecurity: SecurityRequirements | undefined = toolState.security;
    const serviceSecurity: SecurityRequirements | undefined = service.security;
    const effectiveSecurity = toolSecurity ?? serviceSecurity;
    const serviceDomain = service.adapterDomain as ServiceDomain;

    const params = input.parameters as Record<string, Record<string, unknown>>;

    let authHeaders: Record<string, string> = {};
    let authQuery: Record<string, string> = {};
    let authCookies: Record<string, string> = {};
    if (effectiveSecurity && effectiveSecurity.length > 0) {
      if (!service.credentials) {
        throw new Error(
          `No credential provider is available for service '${input.serviceId}'.`,
        );
      }
      const placements = await resolveAuthPlacements(
        service.schemes,
        effectiveSecurity,
        service.credentials,
      );
      authHeaders = placements.headers;
      authQuery = placements.query;
      authCookies = placements.cookies;
    }

    const config = service.config as ConfigProvider<Record<string, unknown>>;
    const baseUrl = await resolveServerUrl(serviceDomain.servers ?? [], config);
    const path = substitutePathParams(toolDomain.path, params.path);
    const invokeLogger = this.logger?.child({
      phase: "adapter-invoke",
    });
    for (const key of Object.keys(authQuery)) {
      if ((params.query ?? {})[key] !== undefined) {
        invokeLogger?.debug(
          { event: "auth-param-collision", location: "query", key },
          "Auth query param overwrites user-supplied value",
        );
      }
    }
    for (const key of Object.keys(authCookies)) {
      if ((params.cookies ?? {})[key] !== undefined) {
        invokeLogger?.debug(
          { event: "auth-param-collision", location: "cookie", key },
          "Auth cookie overwrites user-supplied value",
        );
      }
    }
    for (const key of Object.keys(authHeaders)) {
      if ((params.headers ?? {})[key] !== undefined) {
        invokeLogger?.debug(
          { event: "auth-param-collision", location: "header", key },
          "Auth header overwrites user-supplied value",
        );
      }
    }
    const qs = buildQueryString({ ...(params.query ?? {}), ...authQuery });
    const url = `${baseUrl.replace(/\/+$/, "")}${path}${qs}`;

    const headerParams = (params.headers ?? {}) as Record<string, string>;

    const headers: Record<string, string> = { ...headerParams, ...authHeaders };

    const cookies: Record<string, unknown> = {
      ...(params.cookies ?? {}),
      ...authCookies,
    };
    if (Object.keys(cookies).length > 0) {
      headers.Cookie = Object.entries(cookies)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join("; ");
    }

    const configuredTimeout = await readOptionalConfig(config, "timeoutMs");
    const timeoutMs =
      typeof configuredTimeout === "number" ? configuredTimeout : 30000;

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
  secretsSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  instantiate: () => new OpenapiAdapter(),
};
