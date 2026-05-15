import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import { PROCESS_STATES } from "@/models/process.model";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

const jsonObjectSchema = z
  .record(z.string(), z.unknown())
  .describe("Arbitrary JSON object content.");

const patchOperationSchema = z.union([
  z.object({
    op: z.literal("add").describe("Insert a value at the target path."),
    path: z.string().min(1).describe("JSON Pointer path to update."),
    value: z.unknown().describe("Value to insert or replace."),
  }),
  z.object({
    op: z.literal("remove").describe("Remove the value at the target path."),
    path: z.string().min(1).describe("JSON Pointer path to remove."),
  }),
  z.object({
    op: z.literal("replace").describe("Replace the value at the target path."),
    path: z.string().min(1).describe("JSON Pointer path to replace."),
    value: z.unknown().describe("Replacement value."),
  }),
  z.object({
    op: z.literal("move").describe("Move a value from one path to another."),
    path: z.string().min(1).describe("Destination JSON Pointer path."),
    from: z.string().min(1).describe("Source JSON Pointer path."),
  }),
  z.object({
    op: z.literal("copy").describe("Copy a value from one path to another."),
    path: z.string().min(1).describe("Destination JSON Pointer path."),
    from: z.string().min(1).describe("Source JSON Pointer path."),
  }),
  z.object({
    op: z.literal("test").describe("Assert that a path contains a value."),
    path: z.string().min(1).describe("JSON Pointer path to inspect."),
    value: z.unknown().describe("Expected value."),
  }),
]);

const enabledQueryValueSchema = z
  .enum(["true", "false", "null"])
  .describe(
    "String query filter that matches enabled, disabled, or all resources.",
  );

const processStateSchema = z
  .enum(PROCESS_STATES)
  .describe("Current lifecycle state of a process.");

const processStatusSchema = z
  .enum(["failed", "success", "timeout", "canceled"])
  .nullable()
  .describe(
    "Terminal execution status; null means the process is not finished yet.",
  );

const processStatusQuerySchema = z
  .enum(["failed", "success", "timeout", "canceled", "null"])
  .describe(
    "Filter processes by terminal status; use null to include non-terminal processes.",
  );

const discoverEnabledBodySchema = z
  .boolean()
  .nullable()
  .describe(
    "Whether to return enabled items only; null returns both enabled and disabled items.",
  );

const serviceInstallSourceSchema = z
  .union([
    z.string().min(1).describe("Direct URL to the service definition file."),
    z
      .object({
        file_url: z
          .string()
          .optional()
          .describe("Primary definition URL for the service."),
        metadata: z
          .object({
            file_url: z
              .string()
              .optional()
              .describe("Fallback definition URL stored in metadata."),
          })
          .optional()
          .describe("Optional metadata container used by some registries."),
      })
      .describe(
        "Structured registry payload that may contain the definition URL in the root or metadata.",
      ),
  ])
  .describe(
    "Service definition source. Accepts a direct URL string or an object containing a file_url in the root or metadata.",
  );

const serviceInstallRequestSchema = registry.register(
  "ServiceInstallRequest",
  z
    .object({
      type: z
        .string()
        .min(1)
        .describe(
          "Service adapter type to install, such as a registry or transport implementation.",
        ),
      source: serviceInstallSourceSchema.describe(
        "Registry definition location. The controller normalizes this before downloading the manifest.",
      ),
    })
    .describe(
      "Request body used to install a service manifest from a registry definition file.",
    ),
);

export const ServiceInstallRequestSchema = serviceInstallRequestSchema;

export const ServiceListItemSchema = registry.register(
  "ServiceListItem",
  z
    .object({
      name: z
        .string()
        .min(1)
        .describe("Normalized service name used as the manifest identifier."),
      type: z
        .string()
        .min(1)
        .describe("Service adapter type declared by the manifest."),
      source: z
        .string()
        .min(1)
        .describe(
          "Normalized install source used to fetch the manifest definition.",
        ),
      description: z
        .string()
        .describe("Human-readable summary of the service manifest."),
      hash: z
        .string()
        .min(1)
        .describe(
          "Content hash of the currently installed manifest definition.",
        ),
      enabled: z
        .boolean()
        .describe(
          "Whether the service is currently allowed to participate in staging and discovery.",
        ),
    })
    .describe(
      "Compact service summary returned by list and discovery operations.",
    ),
);

export const ServiceDiscoverItemSchema = registry.register(
  "ServiceDiscoverItem",
  z
    .object({
      name: z
        .string()
        .min(1)
        .describe("Normalized service name used for discovery results."),
      description: z
        .string()
        .describe(
          "Short description of the service that helps users identify it.",
        ),
      enabled: z
        .boolean()
        .describe("Whether the service is currently enabled."),
    })
    .describe(
      "Service discovery entry used by higher-level search and browse flows.",
    ),
);

export const ServiceDetailsSchema = registry.register(
  "ServiceDetails",
  z
    .object({
      name: z
        .string()
        .min(1)
        .describe("Normalized service name used as the manifest identifier."),
      type: z
        .string()
        .min(1)
        .describe("Service adapter type declared by the manifest."),
      source: z
        .string()
        .min(1)
        .describe("Normalized source used to install or update the manifest."),
      description: z.string().describe("Human-readable service description."),
      hash: z
        .string()
        .min(1)
        .describe("Content hash of the installed manifest definition."),
      enabled: z
        .boolean()
        .describe("Whether the service is enabled for staging and execution."),
      configSchema: jsonObjectSchema.describe(
        "JSON Schema describing the service configuration object.",
      ),
      secretsSchema: jsonObjectSchema.describe(
        "JSON Schema describing the service secrets object.",
      ),
    })
    .describe(
      "Complete service metadata payload returned by the service detail endpoint.",
    ),
);

export const ToolListItemSchema = registry.register(
  "ToolListItem",
  z
    .object({
      name: z
        .string()
        .min(1)
        .describe("Tool name as exposed by the service manifest."),
      description: z.string().describe("Human-readable tool description."),
      enabled: z
        .boolean()
        .describe("Whether the tool is enabled for invocation."),
    })
    .describe("Tool summary returned when listing tools for a service."),
);

export const ToolDiscoverItemSchema = registry.register(
  "ToolDiscoverItem",
  z
    .object({
      serviceName: z
        .string()
        .min(1)
        .describe("Owning service name for the discovered tool."),
      name: z
        .string()
        .min(1)
        .describe("Tool name as exposed by the service manifest."),
      description: z.string().describe("Human-readable tool description."),
      enabled: z
        .boolean()
        .describe("Whether the tool is currently enabled and callable."),
    })
    .describe(
      "Tool discovery entry used by search endpoints and discovery messages.",
    ),
);

export const ToolDetailsSchema = registry.register(
  "ToolDetails",
  z
    .object({
      name: z
        .string()
        .min(1)
        .describe("Tool name as exposed by the service manifest."),
      description: z.string().describe("Human-readable tool description."),
      enabled: z
        .boolean()
        .describe(
          "Whether the tool is enabled after accounting for the parent service state.",
        ),
      inputSchema: jsonObjectSchema.describe(
        "JSON Schema describing the tool input payload.",
      ),
      outputSchema: jsonObjectSchema.describe(
        "JSON Schema describing the tool output payload.",
      ),
    })
    .describe(
      "Expanded tool metadata payload returned by the tool detail endpoint.",
    ),
);

export const ProcessSchema = registry.register(
  "Process",
  z
    .object({
      pid: z
        .number()
        .int()
        .positive()
        .describe("Numeric process identifier assigned by the API."),
      ref: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Optional caller-supplied reference string used to group related processes.",
        ),
      state: processStateSchema.describe(
        "Current lifecycle state of the process.",
      ),
      status: processStatusSchema.describe(
        "Terminal outcome of the process when it reaches the idle state.",
      ),
    })
    .describe(
      "Process status snapshot returned by process management endpoints.",
    ),
);

export const ProcessListResponseSchema = registry.register(
  "ProcessListResponse",
  z
    .object({
      processes: z
        .array(ProcessSchema)
        .describe("Processes matching the provided query filters."),
    })
    .describe("Collection wrapper for process listings."),
);

export const ProcessCreateRequestSchema = registry.register(
  "ProcessCreateRequest",
  z
    .object({
      code: z
        .string()
        .describe(
          "Executable source code or script body to stage and run in the process environment.",
        ),
      block: z
        .boolean()
        .optional()
        .describe(
          "When true, waits for the process to become idle before responding.",
        ),
      ref: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Optional reference label used for filtering and correlation.",
        ),
      timeout: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe(
          "Optional timeout in milliseconds. Null explicitly clears the timeout.",
        ),
    })
    .describe("Request body used to create a new process entry."),
);

export const ProcessCreatedResponseSchema = registry.register(
  "ProcessCreatedResponse",
  z
    .object({
      pid: z
        .number()
        .int()
        .positive()
        .describe("Numeric identifier assigned to the newly created process."),
    })
    .describe("Response returned when a process is created."),
);

export const ProcessOutputSchema = registry.register(
  "ProcessOutput",
  jsonObjectSchema.describe(
    "Structured output collected from the process execution environment.",
  ),
);

export const RunSignalRequestSchema = registry.register(
  "RunSignalRequest",
  z
    .object({
      force: z
        .boolean()
        .optional()
        .describe(
          "When true, reruns a process even if prior output already exists.",
        ),
      block: z
        .boolean()
        .optional()
        .describe(
          "When true, waits until execution completes before returning.",
        ),
    })
    .describe(
      "Request body used to dispatch a run signal to an existing process.",
    ),
);

export const ProcessKillRequestSchema = registry.register(
  "ProcessKillRequest",
  jsonObjectSchema.describe(
    "Any JSON object. The payload is ignored and only object-ness is validated.",
  ),
);

export const ServiceListResponseSchema = registry.register(
  "ServiceListResponse",
  z
    .object({
      services: z
        .array(ServiceListItemSchema)
        .describe("Services that match the current query filters."),
    })
    .describe(
      "Collection wrapper for service listings and discovery responses.",
    ),
);

export const ToolListResponseSchema = registry.register(
  "ToolListResponse",
  z
    .object({
      tools: z
        .array(ToolListItemSchema)
        .describe(
          "Tools that belong to the requested service and match any filters.",
        ),
    })
    .describe("Collection wrapper for service tool listings."),
);

export const DiscoverToolsRequestSchema = registry.register(
  "DiscoverToolsRequest",
  z
    .object({
      query: z
        .string()
        .optional()
        .describe(
          "Free-text query used to match tool names, descriptions, and service names.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of matching tools to return."),
      enabled: discoverEnabledBodySchema
        .optional()
        .describe(
          "When set, returns only enabled tools, only disabled tools, or both when null.",
        ),
    })
    .describe("Request body used to discover tools across all known services."),
);

export const DiscoverServicesRequestSchema = registry.register(
  "DiscoverServicesRequest",
  z
    .object({
      query: z
        .string()
        .optional()
        .describe(
          "Free-text query used to match service names and descriptions.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of matching services to return."),
      enabled: discoverEnabledBodySchema
        .optional()
        .describe(
          "When set, returns only enabled services, only disabled services, or both when null.",
        ),
    })
    .describe("Request body used to discover services."),
);

export const DiscoverToolsResponseSchema = registry.register(
  "DiscoverToolsResponse",
  z
    .object({
      tools: z
        .array(ToolDiscoverItemSchema)
        .describe(
          "Discovered tools that satisfy the supplied search query and enabled filter.",
        ),
    })
    .describe("Response body returned by the tool discovery endpoint."),
);

export const DiscoverServicesResponseSchema = registry.register(
  "DiscoverServicesResponse",
  z
    .object({
      services: z
        .array(ServiceListItemSchema)
        .describe(
          "Discovered services that satisfy the supplied search query and enabled filter.",
        ),
    })
    .describe("Response body returned by the service discovery endpoint."),
);

export const ServiceUpdateResponseSchema = registry.register(
  "ServiceUpdateResponse",
  z
    .object({
      name: z
        .string()
        .min(1)
        .describe("Service name that was checked for updates."),
      updated: z
        .boolean()
        .describe("Whether the service manifest changed and was rewritten."),
    })
    .describe("Response returned by the service update endpoint."),
);

export const ServiceEnabledResponseSchema = registry.register(
  "ServiceEnabledResponse",
  z
    .object({
      name: z
        .string()
        .min(1)
        .describe("Service name whose enabled state was updated."),
      enabled: z
        .boolean()
        .describe("The new enabled state stored for the service."),
    })
    .describe("Response returned after toggling a service enabled state."),
);

export const ServiceToolEnabledResponseSchema = registry.register(
  "ServiceToolEnabledResponse",
  z
    .object({
      name: z
        .string()
        .min(1)
        .describe("Tool name whose enabled state was updated."),
      serviceName: z
        .string()
        .min(1)
        .describe("Owning service name for the tool."),
      enabled: z
        .boolean()
        .describe("The new enabled state stored for the tool."),
    })
    .describe("Response returned after toggling a tool enabled state."),
);

export const ServiceConfigurationResponseSchema = registry.register(
  "ServiceConfigurationResponse",
  z
    .object({
      config: jsonObjectSchema.describe(
        "Current normalized configuration payload for the service.",
      ),
    })
    .describe("Wrapper for a service configuration document."),
);

export const ServiceConfigurationSchemaResponseSchema = registry.register(
  "ServiceConfigurationSchemaResponse",
  z
    .object({
      configSchema: jsonObjectSchema.describe(
        "JSON Schema used to validate the service configuration payload.",
      ),
    })
    .describe("Wrapper for a service configuration schema document."),
);

export const ServiceSecretsSchemaResponseSchema = registry.register(
  "ServiceSecretsSchemaResponse",
  z
    .object({
      secretsSchema: jsonObjectSchema.describe(
        "JSON Schema used to validate the service secrets payload.",
      ),
    })
    .describe("Wrapper for a service secrets schema document."),
);

export const ServiceSecretsResponseSchema = registry.register(
  "ServiceSecretsResponse",
  z
    .object({
      updated: z
        .boolean()
        .describe(
          "Acknowledges that the secrets patch was accepted and persisted.",
        ),
    })
    .describe("Response returned after patching service secrets."),
);

export const ServiceCreatedResponseSchema = registry.register(
  "ServiceCreatedResponse",
  z
    .object({
      name: z
        .string()
        .min(1)
        .describe(
          "Normalized service name assigned to the installed manifest.",
        ),
      type: z
        .string()
        .min(1)
        .describe("Service adapter type selected during installation."),
    })
    .describe("Response returned after successfully installing a new service."),
);

export const ApiErrorResponseSchema = registry.register(
  "ApiErrorResponse",
  z
    .object({
      error: z
        .string()
        .describe("Human-readable error message returned by the API."),
    })
    .describe("Standard error envelope used by the HTTP error middleware."),
);

export const ErrorSchema = ApiErrorResponseSchema;

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  "application/json": { schema },
});

const textContent = (schema: z.ZodTypeAny) => ({
  "text/plain": { schema },
});

const apiErrorResponse = (description: string) => ({
  description,
  content: jsonContent(ApiErrorResponseSchema),
});

registry.registerPath({
  method: "post",
  path: "/discover/tools",
  tags: ["Discover"],
  summary: "Discover tools across all services",
  description:
    "Searches every known tool by name, description, and owning service name. If the request omits enabled, only enabled tools are returned by default. Set enabled to null to include both enabled and disabled tools.",
  request: { body: { content: jsonContent(DiscoverToolsRequestSchema) } },
  responses: {
    200: {
      description: "Tool discovery results.",
      content: jsonContent(DiscoverToolsResponseSchema),
    },
    400: apiErrorResponse(
      "The request body was malformed or contained invalid filter values.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    500: apiErrorResponse(
      "A database or discovery failure prevented the search from completing.",
    ),
  },
});

registry.registerPath({
  method: "post",
  path: "/discover/services",
  tags: ["Discover"],
  summary: "Discover services",
  description:
    "Searches service manifests by name and description. If the request omits enabled, only enabled services are returned by default. Set enabled to null to include both enabled and disabled services.",
  request: { body: { content: jsonContent(DiscoverServicesRequestSchema) } },
  responses: {
    200: {
      description: "Service discovery results.",
      content: jsonContent(DiscoverServicesResponseSchema),
    },
    400: apiErrorResponse(
      "The request body was malformed or contained invalid filter values.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    500: apiErrorResponse(
      "A database or discovery failure prevented the search from completing.",
    ),
  },
});

registry.registerPath({
  method: "get",
  path: "/processes",
  tags: ["Processes"],
  summary: "List processes",
  description:
    "Returns process snapshots filtered by optional ref, state, and status query parameters. The status filter accepts success, failed, timeout, canceled, or null.",
  request: {
    query: z.object({
      ref: z
        .string()
        .optional()
        .describe("Optional reference string used to filter processes."),
      state: processStateSchema.optional(),
      status: processStatusQuerySchema.optional(),
    }),
  },
  responses: {
    200: {
      description: "Matching processes.",
      content: jsonContent(ProcessListResponseSchema),
    },
    400: apiErrorResponse("One or more query parameters could not be parsed."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    500: apiErrorResponse("The process list could not be loaded."),
  },
});

registry.registerPath({
  method: "post",
  path: "/processes",
  tags: ["Processes"],
  summary: "Create a process",
  description:
    "Stages new code as a process. The optional block flag waits until execution is idle before the response is returned. The optional timeout is expressed in milliseconds and may be null to explicitly clear it.",
  request: { body: { content: jsonContent(ProcessCreateRequestSchema) } },
  responses: {
    201: {
      description: "Process created successfully.",
      content: jsonContent(ProcessCreatedResponseSchema),
    },
    400: apiErrorResponse(
      "The request body was invalid or missing the required code field.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    503: apiErrorResponse(
      "No staged environment was available or the API is shutting down.",
    ),
    500: apiErrorResponse("The process could not be created."),
  },
});

registry.registerPath({
  method: "get",
  path: "/processes/{pid}",
  tags: ["Processes"],
  summary: "Get a process",
  description:
    "Returns the current process snapshot for the requested process identifier.",
  request: {
    params: z.object({
      pid: z.number().int().positive().describe("Numeric process identifier."),
    }),
  },
  responses: {
    200: {
      description: "Process snapshot.",
      content: jsonContent(ProcessSchema),
    },
    400: apiErrorResponse("The pid path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("No process exists for the requested identifier."),
    500: apiErrorResponse("The process could not be loaded."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/processes/{pid}",
  tags: ["Processes"],
  summary: "Delete a process",
  description:
    "Deletes an idle process snapshot. Active processes must be stopped before deletion.",
  request: {
    params: z.object({
      pid: z.number().int().positive().describe("Numeric process identifier."),
    }),
  },
  responses: {
    200: {
      description: "The deleted process snapshot.",
      content: jsonContent(ProcessSchema),
    },
    400: apiErrorResponse("The pid path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("No process exists for the requested identifier."),
    409: apiErrorResponse("The process is not idle and cannot be deleted."),
    500: apiErrorResponse("The process could not be deleted."),
  },
});

registry.registerPath({
  method: "get",
  path: "/processes/{pid}/code",
  tags: ["Processes"],
  summary: "Get stored process code",
  description:
    "Returns the exact source code stored for a process as plain text. This is useful for debugging and auditing the code that produced the execution output.",
  request: {
    params: z.object({
      pid: z.number().int().positive().describe("Numeric process identifier."),
    }),
  },
  responses: {
    200: {
      description: "The stored source code.",
      content: textContent(z.string().describe("Process source code.")),
    },
    400: apiErrorResponse("The pid path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("No process exists for the requested identifier."),
    500: apiErrorResponse("The stored process code could not be loaded."),
  },
});

registry.registerPath({
  method: "get",
  path: "/processes/{pid}/output",
  tags: ["Processes"],
  summary: "Get process output",
  description:
    "Returns the collected structured output for a completed process. Output is only available once the process is idle.",
  request: {
    params: z.object({
      pid: z.number().int().positive().describe("Numeric process identifier."),
    }),
  },
  responses: {
    200: {
      description: "Structured process output.",
      content: jsonContent(ProcessOutputSchema),
    },
    400: apiErrorResponse("The pid path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("No process exists for the requested identifier."),
    409: apiErrorResponse(
      "The process has not finished yet, so output is not available.",
    ),
    500: apiErrorResponse("The output could not be loaded."),
  },
});

registry.registerPath({
  method: "get",
  path: "/processes/{pid}/stdout",
  tags: ["Processes"],
  summary: "Get process stdout",
  description:
    "Returns the captured standard output for a completed process as plain text. Output is only available once the process is idle.",
  request: {
    params: z.object({
      pid: z.number().int().positive().describe("Numeric process identifier."),
    }),
  },
  responses: {
    200: {
      description: "Captured stdout text.",
      content: textContent(z.string().describe("Standard output content.")),
    },
    400: apiErrorResponse("The pid path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("No process exists for the requested identifier."),
    409: apiErrorResponse(
      "The process has not finished yet, so stdout is not available.",
    ),
    500: apiErrorResponse("The stdout stream could not be loaded."),
  },
});

registry.registerPath({
  method: "get",
  path: "/processes/{pid}/stderr",
  tags: ["Processes"],
  summary: "Get process stderr",
  description:
    "Returns the captured standard error for a completed process as plain text. Output is only available once the process is idle.",
  request: {
    params: z.object({
      pid: z.number().int().positive().describe("Numeric process identifier."),
    }),
  },
  responses: {
    200: {
      description: "Captured stderr text.",
      content: textContent(z.string().describe("Standard error content.")),
    },
    400: apiErrorResponse("The pid path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("No process exists for the requested identifier."),
    409: apiErrorResponse(
      "The process has not finished yet, so stderr is not available.",
    ),
    500: apiErrorResponse("The stderr stream could not be loaded."),
  },
});

registry.registerPath({
  method: "post",
  path: "/processes/{pid}/signals/run",
  tags: ["Processes"],
  summary: "Run a process",
  description:
    "Queues an idle process for execution. Set force to true to rerun a process that already produced output. Set block to true to wait for the process to return to the idle state before responding.",
  request: {
    params: z.object({
      pid: z.number().int().positive().describe("Numeric process identifier."),
    }),
    body: { content: jsonContent(RunSignalRequestSchema) },
  },
  responses: {
    200: {
      description: "The queued or completed process snapshot.",
      content: jsonContent(ProcessSchema),
    },
    400: apiErrorResponse(
      "The pid path parameter or request body was invalid.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("No process exists for the requested identifier."),
    409: apiErrorResponse(
      "The process must be idle before it can be run again.",
    ),
    503: apiErrorResponse(
      "No staged environment was available or the API is shutting down.",
    ),
    500: apiErrorResponse("The process could not be queued."),
  },
});

registry.registerPath({
  method: "post",
  path: "/processes/{pid}/signals/kill",
  tags: ["Processes"],
  summary: "Kill a process",
  description:
    "Signals an active process to terminate. The body is accepted only to validate that the request is a JSON object; its contents are ignored.",
  request: {
    params: z.object({
      pid: z.number().int().positive().describe("Numeric process identifier."),
    }),
    body: { content: jsonContent(ProcessKillRequestSchema) },
  },
  responses: {
    200: {
      description: "The updated process snapshot after the kill request.",
      content: jsonContent(ProcessSchema),
    },
    400: apiErrorResponse(
      "The pid path parameter was invalid or the request body was not a JSON object.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("No process exists for the requested identifier."),
    409: apiErrorResponse(
      "The process is already idle or is already terminating.",
    ),
    500: apiErrorResponse("The process could not be terminated."),
  },
});

registry.registerPath({
  method: "get",
  path: "/services",
  tags: ["Services"],
  summary: "List services",
  description:
    "Returns the installed services. The query filter is trimmed before matching, and enabled accepts true, false, or null. Omit enabled to return all services.",
  request: {
    query: z.object({
      query: z
        .string()
        .optional()
        .describe(
          "Free-text query used to match service names and descriptions.",
        ),
      enabled: enabledQueryValueSchema
        .optional()
        .describe("Enabled-state filter. Omit to return all services."),
    }),
  },
  responses: {
    200: {
      description: "Matching services.",
      content: jsonContent(ServiceListResponseSchema),
    },
    400: apiErrorResponse("One or more query parameters could not be parsed."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    500: apiErrorResponse("The service list could not be loaded."),
  },
});

registry.registerPath({
  method: "get",
  path: "/services/{serviceName}",
  tags: ["Services"],
  summary: "Get a service",
  description:
    "Returns the manifest metadata, hashes, and schema documents for the requested service.",
  request: {
    params: z.object({
      serviceName: z.string().min(1).describe("Normalized service name."),
    }),
  },
  responses: {
    200: {
      description: "Service details.",
      content: jsonContent(ServiceDetailsSchema),
    },
    400: apiErrorResponse("The service name path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The service manifest could not be found."),
    500: apiErrorResponse("The service details could not be loaded."),
  },
});

registry.registerPath({
  method: "post",
  path: "/services/install",
  tags: ["Services"],
  summary: "Install a service",
  description:
    "Downloads a registry definition, validates the manifest, and stores it as a new service. The source may be a direct URL or a structured object containing a file_url. Installation does not automatically enable the service.",
  request: { body: { content: jsonContent(ServiceInstallRequestSchema) } },
  responses: {
    201: {
      description: "The service was installed and stored.",
      content: jsonContent(ServiceCreatedResponseSchema),
    },
    400: apiErrorResponse(
      "The install payload was invalid or the definition content failed validation.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    409: apiErrorResponse(
      "A manifest already exists for the requested service name.",
    ),
    413: apiErrorResponse(
      "The downloaded manifest definition exceeded the configured size limit.",
    ),
    502: apiErrorResponse(
      "The definition could not be downloaded or the redirected URL was invalid.",
    ),
    500: apiErrorResponse("The service could not be installed."),
  },
});

registry.registerPath({
  method: "post",
  path: "/services/{serviceName}/update",
  tags: ["Services"],
  summary: "Update a service manifest",
  description:
    "Re-downloads the stored definition source, compares hashes, and updates the manifest if the remote definition changed. If the hash is unchanged the response reports updated: false.",
  request: {
    params: z.object({
      serviceName: z.string().min(1).describe("Normalized service name."),
    }),
  },
  responses: {
    200: {
      description: "Update result for the requested service.",
      content: jsonContent(ServiceUpdateResponseSchema),
    },
    400: apiErrorResponse(
      "The service name or updated manifest content was invalid.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The service manifest could not be found."),
    409: apiErrorResponse(
      "The service cannot be updated automatically because no install source is stored, or the manifest name no longer matches.",
    ),
    413: apiErrorResponse(
      "The downloaded manifest definition exceeded the configured size limit.",
    ),
    502: apiErrorResponse(
      "The definition could not be downloaded or the redirected URL was invalid.",
    ),
    500: apiErrorResponse("The service could not be updated."),
  },
});

registry.registerPath({
  method: "post",
  path: "/services/{serviceName}/enabled",
  tags: ["Services"],
  summary: "Toggle a service",
  description:
    "Sets whether a service is enabled. When enabling, the stored configuration and secrets are validated against their schemas before the change is persisted.",
  request: {
    params: z.object({
      serviceName: z.string().min(1).describe("Normalized service name."),
    }),
    body: {
      content: jsonContent(
        registry.register(
          "ServiceEnabledRequest",
          z
            .object({
              enabled: z
                .boolean()
                .describe("Desired enabled state for the service."),
            })
            .describe("Request body used to enable or disable a service."),
        ),
      ),
    },
  },
  responses: {
    200: {
      description: "Updated enabled state.",
      content: jsonContent(ServiceEnabledResponseSchema),
    },
    400: apiErrorResponse(
      "The request body or the stored configuration/secrets failed validation.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The service manifest could not be found."),
    500: apiErrorResponse("The service could not be updated."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/services/{serviceName}",
  tags: ["Services"],
  summary: "Delete a service",
  description:
    "Deletes a service manifest and its associated tool records. A restage is requested after deletion so the environment pool can refresh.",
  request: {
    params: z.object({
      serviceName: z.string().min(1).describe("Normalized service name."),
    }),
  },
  responses: {
    204: { description: "The service was deleted successfully." },
    400: apiErrorResponse("The service name path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The service manifest could not be found."),
    500: apiErrorResponse("The service could not be deleted."),
  },
});

registry.registerPath({
  method: "get",
  path: "/services/{serviceName}/configuration/schema",
  tags: ["Services"],
  summary: "Get a service configuration schema",
  description:
    "Returns the JSON Schema used to validate the service configuration payload.",
  request: {
    params: z.object({
      serviceName: z.string().min(1).describe("Normalized service name."),
    }),
  },
  responses: {
    200: {
      description: "Configuration schema document.",
      content: jsonContent(ServiceConfigurationSchemaResponseSchema),
    },
    400: apiErrorResponse("The service name path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The service manifest could not be found."),
    500: apiErrorResponse("The configuration schema could not be loaded."),
  },
});

registry.registerPath({
  method: "get",
  path: "/services/{serviceName}/configuration",
  tags: ["Services"],
  summary: "Get service configuration",
  description:
    "Returns the normalized configuration payload stored for the service. If no configuration exists yet, an empty object is returned.",
  request: {
    params: z.object({
      serviceName: z.string().min(1).describe("Normalized service name."),
    }),
  },
  responses: {
    200: {
      description: "Current service configuration.",
      content: jsonContent(ServiceConfigurationResponseSchema),
    },
    400: apiErrorResponse("The service name path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    500: apiErrorResponse("The configuration could not be loaded."),
  },
});

registry.registerPath({
  method: "patch",
  path: "/services/{serviceName}/configuration",
  tags: ["Services"],
  summary: "Patch service configuration",
  description:
    "Applies a JSON Patch document to the stored configuration, validates the updated document against the schema, and persists the result. The patch body must be an array of RFC 6902 operations.",
  request: {
    params: z.object({
      serviceName: z.string().min(1).describe("Normalized service name."),
    }),
    body: {
      content: jsonContent(
        z
          .array(patchOperationSchema)
          .describe("JSON Patch operations applied in order."),
      ),
    },
  },
  responses: {
    200: {
      description: "The updated configuration payload.",
      content: jsonContent(ServiceConfigurationResponseSchema),
    },
    400: apiErrorResponse(
      "The JSON Patch document was invalid or produced a configuration that violates the schema.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The service manifest could not be found."),
    500: apiErrorResponse("The configuration could not be persisted."),
  },
});

registry.registerPath({
  method: "get",
  path: "/services/{serviceName}/secrets/schema",
  tags: ["Services"],
  summary: "Get a service secrets schema",
  description:
    "Returns the JSON Schema used to validate the service secrets payload.",
  request: {
    params: z.object({
      serviceName: z.string().min(1).describe("Normalized service name."),
    }),
  },
  responses: {
    200: {
      description: "Secrets schema document.",
      content: jsonContent(ServiceSecretsSchemaResponseSchema),
    },
    400: apiErrorResponse("The service name path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The service manifest could not be found."),
    500: apiErrorResponse("The secrets schema could not be loaded."),
  },
});

registry.registerPath({
  method: "patch",
  path: "/services/{serviceName}/secrets",
  tags: ["Services"],
  summary: "Patch service secrets",
  description:
    "Applies a JSON Patch document to the encrypted secrets payload, validates the result, and persists the updated secrets. The response only confirms success; secrets are not echoed back.",
  request: {
    params: z.object({
      serviceName: z.string().min(1).describe("Normalized service name."),
    }),
    body: {
      content: jsonContent(
        z
          .array(patchOperationSchema)
          .describe("JSON Patch operations applied in order."),
      ),
    },
  },
  responses: {
    200: {
      description: "Confirmation that the secrets payload was updated.",
      content: jsonContent(ServiceSecretsResponseSchema),
    },
    400: apiErrorResponse(
      "The JSON Patch document was invalid or produced a secrets payload that violates the schema.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The service manifest could not be found."),
    500: apiErrorResponse("The secrets could not be persisted."),
  },
});

registry.registerPath({
  method: "get",
  path: "/services/{serviceName}/tools",
  tags: ["Services"],
  summary: "List tools for a service",
  description:
    "Returns tools declared by the requested service. Query filtering is trimmed before matching. The enabled query accepts true, false, or null; omitting it returns all tools.",
  request: {
    params: z.object({
      serviceName: z.string().min(1).describe("Normalized service name."),
    }),
    query: z.object({
      query: z
        .string()
        .optional()
        .describe("Free-text query used to match tool names and descriptions."),
      enabled: enabledQueryValueSchema
        .optional()
        .describe("Enabled-state filter. Omit to return all tools."),
    }),
  },
  responses: {
    200: {
      description: "Matching tools for the service.",
      content: jsonContent(ToolListResponseSchema),
    },
    400: apiErrorResponse("The service name or query parameters were invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The service manifest could not be found."),
    500: apiErrorResponse("The tool list could not be loaded."),
  },
});

registry.registerPath({
  method: "get",
  path: "/services/{serviceName}/tools/{toolName}",
  tags: ["Services"],
  summary: "Get a tool",
  description:
    "Returns detailed metadata for a tool within a service, including the input and output schemas.",
  request: {
    params: z.object({
      serviceName: z.string().min(1).describe("Normalized service name."),
      toolName: z
        .string()
        .min(1)
        .describe("Tool name within the service manifest."),
    }),
  },
  responses: {
    200: {
      description: "Tool details.",
      content: jsonContent(ToolDetailsSchema),
    },
    400: apiErrorResponse(
      "The service name or tool name path parameter was invalid.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The service or tool could not be found."),
    409: apiErrorResponse(
      "The tool name is ambiguous across multiple services.",
    ),
    500: apiErrorResponse("The tool details could not be loaded."),
  },
});

registry.registerPath({
  method: "post",
  path: "/services/{serviceName}/tools/{toolName}/enabled",
  tags: ["Services"],
  summary: "Toggle a tool",
  description:
    "Sets whether a tool is enabled. The parent service can still disable the tool at runtime even if the stored tool flag is true.",
  request: {
    params: z.object({
      serviceName: z.string().min(1).describe("Normalized service name."),
      toolName: z
        .string()
        .min(1)
        .describe("Tool name within the service manifest."),
    }),
    body: {
      content: jsonContent(
        registry.register(
          "ToolEnabledRequest",
          z
            .object({
              enabled: z
                .boolean()
                .describe("Desired enabled state for the tool."),
            })
            .describe("Request body used to enable or disable a tool."),
        ),
      ),
    },
  },
  responses: {
    200: {
      description: "Updated tool enabled state.",
      content: jsonContent(ServiceToolEnabledResponseSchema),
    },
    400: apiErrorResponse("The request body or path parameters were invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The tool could not be found."),
    500: apiErrorResponse("The tool could not be updated."),
  },
});
