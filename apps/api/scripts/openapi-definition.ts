import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from "@asteasolutions/zod-to-openapi";
import type { OpenAPIObject } from "openapi3-ts/oas30";
import { z } from "zod";

import { MODULE_TYPES } from "../src/models/modules.model";
import {
  PROCESS_EXIT_STATES,
  PROCESS_STATES,
} from "../src/models/process.model";

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

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

const patchBodySchema = z
  .array(patchOperationSchema)
  .describe("JSON Patch operations applied in order.");

const booleanQuerySchema = z
  .enum(["true", "false"])
  .describe("String boolean query parameter that accepts 'true' or 'false'.");

const processStateSchema = z
  .enum(PROCESS_STATES)
  .describe("Current lifecycle state of a process.");

const processExitStateValues = PROCESS_EXIT_STATES.filter(
  (value): value is Exclude<(typeof PROCESS_EXIT_STATES)[number], null> =>
    value !== null,
);

const processExitStateSchema = z
  .enum(processExitStateValues)
  .nullable()
  .describe(
    "Terminal execution state of the process. Null while the process has not finished yet.",
  );

const processStatusQuerySchema = z
  .enum([...processExitStateValues, "null"])
  .describe(
    "Filter processes by terminal exit state. Use 'null' to match processes that have not finished.",
  );

const moduleTypeSchema = z
  .enum(MODULE_TYPES)
  .describe("Module type. Either 'adapter' or 'environment'.");

const moduleEnabledQuerySchema = z
  .enum(["true", "false"])
  .describe("Enabled-state filter. Accepts 'true' or 'false'.");

const idParam = z.object({
  id: z
    .string()
    .describe("Numeric process identifier serialized as a path parameter."),
});

const serviceIdParam = z.object({
  serviceId: z
    .string()
    .min(1)
    .describe("Service identifier matching the installed manifest id."),
});

const moduleIdParam = z.object({
  moduleId: z.string().min(1).describe("Module identifier."),
});

const serviceToolParams = z.object({
  serviceId: z
    .string()
    .min(1)
    .describe("Service identifier matching the installed manifest id."),
  toolId: z
    .string()
    .min(1)
    .describe("Tool identifier exposed by the service manifest."),
});

const ApiErrorResponseSchema = registry.register(
  "ApiErrorResponse",
  z
    .object({
      error: z
        .string()
        .describe("Human-readable error message returned by the API."),
    })
    .describe("Standard error envelope returned by the HTTP error middleware."),
);

const ProcessSchema = registry.register(
  "Process",
  z
    .object({
      id: z
        .number()
        .int()
        .positive()
        .describe(
          "Stable process identifier assigned at creation. Persists across restarts.",
        ),
      ref: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Optional caller-supplied reference string used to correlate related processes.",
        ),
      state: processStateSchema.describe(
        "Current lifecycle state of the process.",
      ),
      exitState: processExitStateSchema.describe(
        "Terminal exit state of the process. Null until the process becomes idle.",
      ),
      error: z
        .string()
        .nullable()
        .describe(
          "Error message captured during execution, or null if no error occurred.",
        ),
      createdAt: z
        .string()
        .describe("ISO-8601 timestamp of when the process was created."),
      completedAt: z
        .string()
        .nullable()
        .describe(
          "ISO-8601 timestamp of when the process completed, or null if still running.",
        ),
    })
    .describe("Process snapshot returned by the process management endpoints."),
);

const ProcessListResponseSchema = registry.register(
  "ProcessListResponse",
  z
    .object({
      processes: z
        .array(ProcessSchema)
        .describe("Processes that match the provided query filters."),
    })
    .describe("Collection wrapper for process listings."),
);

const ProcessCreateRequestSchema = registry.register(
  "ProcessCreateRequest",
  z
    .object({
      code: z
        .string()
        .max(100 * 1024)
        .describe(
          "Executable source code to stage and run in the active environment (max 100 KB).",
        ),
      ref: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Optional reference label used for filtering and correlation.",
        ),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe(
          "API-level execution timeout in milliseconds. null disables enforcement; undefined uses the default.",
        ),
      envConfig: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Opaque per-execution environment configuration passed through to the environment module.",
        ),
      autorun: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Whether to start execution immediately. When false, the process is created in idle state and must be started via the run signal.",
        ),
    })
    .describe("Request body used to create a new process."),
);

const ProcessCreatedResponseSchema = registry.register(
  "ProcessCreatedResponse",
  z
    .object({
      id: z
        .number()
        .int()
        .positive()
        .describe(
          "Stable process identifier assigned to the newly created process.",
        ),
    })
    .describe("Response returned after a process is created."),
);

const ProcessOutputSchema = registry.register(
  "ProcessOutput",
  jsonObjectSchema.describe(
    "Structured output emitted by the process during execution.",
  ),
);

const RunSignalRequestSchema = registry.register(
  "RunSignalRequest",
  z
    .object({
      force: z
        .boolean()
        .optional()
        .describe(
          "When true, reruns a process even if prior output already exists.",
        ),
    })
    .describe(
      "Request body used to dispatch a run signal to an existing process.",
    ),
);

const ProcessKillRequestSchema = registry.register(
  "ProcessKillRequest",
  jsonObjectSchema.describe(
    "Any JSON object. The payload is ignored and only object-ness is validated.",
  ),
);

const ServiceListItemSchema = registry.register(
  "ServiceListItem",
  z
    .object({
      id: z
        .string()
        .min(1)
        .describe("Service identifier used as the manifest primary key."),
      name: z
        .string()
        .min(1)
        .describe("Display name declared by the service manifest."),
      description: z
        .string()
        .describe("Human-readable description of the service."),
      version: z
        .string()
        .min(1)
        .openapi({ example: "1.3.0" })
        .describe("Semantic version of the installed service definition."),
      hash: z
        .string()
        .min(1)
        .describe("Content hash of the installed manifest definition."),
      source: z
        .string()
        .min(1)
        .describe("Install source used to fetch the manifest definition."),
      adapter: z
        .string()
        .min(1)
        .describe("Adapter module identifier that owns the service."),
      enabled: z
        .boolean()
        .describe("Whether the service is currently enabled."),
      stale: z
        .boolean()
        .describe(
          "Whether the service needs to be synced. Stale services cannot be enabled or invoked.",
        ),
      effectivelyEnabled: z
        .boolean()
        .describe(
          "Whether the service is actually usable considering its own enabled state, its parent module's state, and whether the module is missing.",
        ),
    })
    .describe(
      "Compact service summary returned by service list and detail endpoints.",
    ),
);

const ServiceDetailsSchema = registry.register(
  "ServiceDetails",
  ServiceListItemSchema.extend({
    configSchema: jsonObjectSchema.describe(
      "JSON Schema describing the service configuration object.",
    ),
    secretsSchema: jsonObjectSchema.describe(
      "JSON Schema describing the service secrets object.",
    ),
  }).describe("Service metadata including configuration and secrets schemas."),
);

const ServiceListResponseSchema = registry.register(
  "ServiceListResponse",
  z
    .object({
      services: z
        .array(ServiceListItemSchema)
        .describe("Services that match the current query filters."),
    })
    .describe("Collection wrapper for service listings."),
);

const ServiceInstallRequestSchema = registry.register(
  "ServiceInstallRequest",
  z
    .object({
      source: z
        .string()
        .min(1)
        .describe(
          "Registry URL to resolve for service metadata, then download the definition.",
        ),
      adapter: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Optional adapter module identifier. Overrides registry default.",
        ),
      id: z
        .string()
        .min(1)
        .optional()
        .describe("Optional service identifier. Overrides registry default."),
      version: z
        .string()
        .min(1)
        .optional()
        .openapi({ example: "^1.0.0" })
        .describe(
          "Optional semantic range or exact version. Resolves from registry. Defaults to latest.",
        ),
    })
    .describe("Request body used to install a service from a registry."),
);

const ServiceDirectInstallRequestSchema = registry.register(
  "ServiceDirectInstallRequest",
  z
    .object({
      id: z
        .string()
        .min(1)
        .describe(
          "Identifier to assign to the new service. Must be a valid identifier matching /^[A-Za-z_$][A-Za-z0-9_$]*$/.",
        ),
      url: z
        .string()
        .min(1)
        .describe(
          "Direct URL of the service definition file to download and install.",
        ),
      adapter: z
        .string()
        .min(1)
        .describe("Adapter module identifier responsible for the service."),
    })
    .describe("Request body used to install a service from a direct URL."),
);

const ServicePatchRequestSchema = registry.register(
  "ServicePatchRequest",
  z
    .object({
      url: z
        .string()
        .min(1)
        .describe(
          "Direct URL of the new definition file to replace the existing installation.",
        ),
    })
    .describe(
      "Request body used to replace a service via a direct download URL.",
    ),
);

const ServiceCreatedResponseSchema = registry.register(
  "ServiceCreatedResponse",
  z
    .object({
      id: z
        .string()
        .min(1)
        .describe("Identifier assigned to the newly installed service."),
    })
    .describe("Response returned after a service is installed."),
);

const ServiceUpdateResponseSchema = registry.register(
  "ServiceUpdateResponse",
  z
    .object({
      id: z
        .string()
        .min(1)
        .describe("Identifier of the service that was checked for updates."),
      updated: z
        .boolean()
        .describe(
          "Acknowledges that the update request was processed successfully.",
        ),
    })
    .describe("Response returned by the service update endpoint."),
);

const ServicePatchResponseSchema = registry.register(
  "ServicePatchResponse",
  z
    .object({
      updated: z
        .boolean()
        .describe(
          "Whether the service was updated (false if no change detected).",
        ),
    })
    .describe("Response returned by the service patch endpoint."),
);

const ServiceEnabledRequestSchema = registry.register(
  "ServiceEnabledRequest",
  z
    .object({
      enabled: z.boolean().describe("Desired enabled state for the service."),
    })
    .describe("Request body used to toggle a service enabled state."),
);

const ServiceEnabledResponseSchema = registry.register(
  "ServiceEnabledResponse",
  z
    .object({
      id: z
        .string()
        .min(1)
        .describe("Identifier of the service whose enabled state was updated."),
      enabled: z
        .boolean()
        .describe("The new enabled state stored for the service."),
    })
    .describe("Response returned after toggling a service enabled state."),
);

const ServiceConfigurationResponseSchema = registry.register(
  "ServiceConfigurationResponse",
  z
    .object({
      config: jsonObjectSchema.describe(
        "Current configuration payload stored for the service.",
      ),
    })
    .describe("Wrapper for a service configuration document."),
);

const ServiceConfigurationSchemaResponseSchema = registry.register(
  "ServiceConfigurationSchemaResponse",
  z
    .object({
      configSchema: jsonObjectSchema.describe(
        "JSON Schema used to validate the service configuration payload.",
      ),
    })
    .describe("Wrapper for a service configuration schema document."),
);

const ServiceSecretsSchemaResponseSchema = registry.register(
  "ServiceSecretsSchemaResponse",
  z
    .object({
      secretsSchema: jsonObjectSchema.describe(
        "JSON Schema used to validate the service secrets payload.",
      ),
    })
    .describe("Wrapper for a service secrets schema document."),
);

const ServiceSecretsResponseSchema = registry.register(
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

const ServiceSecretsPresenceResponseSchema = registry.register(
  "ServiceSecretsPresenceResponse",
  z
    .object({
      present: z
        .array(z.string())
        .describe("Secrets paths that currently have values set."),
    })
    .describe("Indicates which secrets paths have values present (non-empty)."),
);

const ServiceSyncResponseSchema = registry.register(
  "ServiceSyncResponse",
  z
    .object({
      id: z.string().min(1).describe("Identifier of the synced service."),
      updated: z
        .boolean()
        .describe("Confirms the service definition was re-registered."),
    })
    .describe("Response returned after syncing a service."),
);

const ToolListItemSchema = registry.register(
  "ToolListItem",
  z
    .object({
      serviceId: z
        .string()
        .min(1)
        .describe("Identifier of the service that owns the tool."),
      id: z
        .string()
        .min(1)
        .describe("Tool identifier exposed by the service manifest."),
      name: z
        .string()
        .min(1)
        .describe("Display name declared by the tool definition."),
      description: z.string().describe("Human-readable tool description."),
      enabled: z
        .boolean()
        .describe("Whether the tool is enabled at the manifest level."),
      effectivelyEnabled: z
        .boolean()
        .describe(
          "Whether the tool is callable after accounting for its parent service state.",
        ),
    })
    .describe("Tool summary returned by the tool listing endpoint."),
);

const ToolDetailsSchema = registry.register(
  "ToolDetails",
  z
    .object({
      id: z
        .string()
        .min(1)
        .describe("Tool identifier exposed by the service manifest."),
      name: z
        .string()
        .min(1)
        .describe("Display name declared by the tool definition."),
      description: z.string().describe("Human-readable tool description."),
      enabled: z
        .boolean()
        .describe("Whether the tool is enabled at the manifest level."),
      effectivelyEnabled: z
        .boolean()
        .describe(
          "Whether the tool is callable after accounting for its parent service state.",
        ),
      inputSchema: jsonObjectSchema.describe(
        "JSON Schema describing the tool input payload.",
      ),
      outputSchema: jsonObjectSchema.describe(
        "JSON Schema describing the tool output payload.",
      ),
    })
    .describe("Detailed tool metadata returned by the tool detail endpoint."),
);

const ToolListResponseSchema = registry.register(
  "ToolListResponse",
  z
    .object({
      tools: z
        .array(ToolListItemSchema)
        .describe("Tools that match the supplied filters."),
    })
    .describe("Collection wrapper for tool listings."),
);

const ToolEnabledRequestSchema = registry.register(
  "ToolEnabledRequest",
  z
    .object({
      enabled: z.boolean().describe("Desired enabled state for the tool."),
    })
    .describe("Request body used to toggle a tool enabled state."),
);

const ToolEnabledResponseSchema = registry.register(
  "ToolEnabledResponse",
  z
    .object({
      id: z
        .string()
        .min(1)
        .describe("Identifier of the tool whose enabled state was updated."),
      serviceId: z
        .string()
        .min(1)
        .describe("Identifier of the service that owns the tool."),
      enabled: z
        .boolean()
        .describe("The new enabled state stored for the tool."),
    })
    .describe("Response returned after toggling a tool enabled state."),
);

const ModuleSchema = registry.register(
  "Module",
  z
    .object({
      id: z.string().min(1).describe("Module identifier."),
      name: z.string().min(1).describe("Module display name."),
      type: moduleTypeSchema.describe("Module type."),
      description: z
        .string()
        .describe("Human-readable description of the module."),
      version: z
        .string()
        .min(1)
        .openapi({ example: "2.0.0" })
        .describe("Semantic version of the installed module manifest."),
      isBuiltin: z
        .boolean()
        .describe("Whether the module is bundled with the API."),
      enabled: z.boolean().describe("Whether the module is currently enabled."),
      missing: z
        .boolean()
        .describe(
          "Whether the module is installed but has no matching factory loaded.",
        ),
    })
    .describe("Module manifest record returned by the modules endpoints."),
);

const ModuleListResponseSchema = registry.register(
  "ModuleListResponse",
  z
    .object({
      modules: z
        .array(ModuleSchema)
        .describe("Modules that match the supplied query filters."),
    })
    .describe("Collection wrapper for module listings."),
);

const ModuleDetailsSchema = registry.register(
  "ModuleDetails",
  ModuleSchema.extend({
    hash: z
      .string()
      .min(1)
      .describe("Content hash of the installed module archive."),
    source: z
      .string()
      .min(0)
      .describe("Install source URL used to fetch the module archive."),
    configSchema: jsonObjectSchema.describe(
      "JSON Schema describing the module configuration object.",
    ),
    secretsSchema: jsonObjectSchema.describe(
      "JSON Schema describing the module secrets object.",
    ),
  }).describe(
    "Full module manifest record returned by the get module endpoint.",
  ),
);

const ModuleInstallRequestSchema = registry.register(
  "ModuleInstallRequest",
  z
    .object({
      source: z
        .string()
        .min(1)
        .describe(
          "Registry URL to resolve for module metadata, then download the .tar.zst archive.",
        ),
      version: z
        .string()
        .min(1)
        .optional()
        .openapi({ example: "^1.0.0" })
        .describe(
          "Optional semantic range or exact version. Resolves from registry. Defaults to latest.",
        ),
    })
    .describe("Request body used to install a module from a registry."),
);

const ModuleDirectInstallRequestSchema = registry.register(
  "ModuleDirectInstallRequest",
  z
    .object({
      url: z
        .string()
        .min(1)
        .describe(
          "Direct URL of the .tar.zst module archive to download and install.",
        ),
    })
    .describe("Request body used to install a module from a direct URL."),
);

const ModulePatchRequestSchema = registry.register(
  "ModulePatchRequest",
  z
    .object({
      url: z
        .string()
        .min(1)
        .describe(
          "Direct URL of the new .tar.zst module archive to replace the existing installation.",
        ),
    })
    .describe(
      "Request body used to replace a module via a direct download URL.",
    ),
);

const ModuleUpdateResponseSchema = registry.register(
  "ModuleUpdateResponse",
  z
    .object({
      updated: z
        .boolean()
        .describe(
          "Whether the module was updated (false if no change detected).",
        ),
    })
    .describe("Response returned by the module update endpoint."),
);

const ModuleEnabledRequestSchema = registry.register(
  "ModuleEnabledRequest",
  z
    .object({
      enabled: z.boolean().describe("Desired enabled state for the module."),
    })
    .describe("Request body used to toggle a module enabled state."),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  "application/json": { schema },
});

const textContent = (schema: z.ZodTypeAny, mediaType = "text/plain") => ({
  [mediaType]: { schema },
});

const apiErrorResponse = (description: string) => ({
  description,
  content: jsonContent(ApiErrorResponseSchema),
});

const RateLimitErrorResponseSchema = registry.register(
  "RateLimitErrorResponse",
  z
    .object({
      error: z
        .literal("rate_limit_exceeded")
        .describe("Error code identifying rate-limit rejection."),
      message: z
        .string()
        .describe("Human-readable message with retry instructions."),
      retryAfter: z
        .number()
        .int()
        .positive()
        .describe("Number of seconds to wait before retrying."),
    })
    .describe("Error body returned when a request is rate-limited (HTTP 429)."),
);

const rateLimitResponse = () => ({
  429: {
    description:
      "Rate limit exceeded. The request was throttled. Check Retry-After header.",
    content: jsonContent(RateLimitErrorResponseSchema),
    headers: {
      "X-RateLimit-Limit": {
        schema: { type: "integer" as const },
        description: "Maximum requests allowed in the current window.",
      },
      "X-RateLimit-Remaining": {
        schema: { type: "integer" as const },
        description: "Requests remaining in the current window.",
      },
      "X-RateLimit-Reset": {
        schema: { type: "integer" as const },
        description: "Unix timestamp when the window resets.",
      },
      "Retry-After": {
        schema: { type: "integer" as const },
        description: "Seconds to wait before retrying.",
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/processes",
  tags: ["Processes"],
  summary: "List processes",
  description:
    "Returns process snapshots filtered by optional ref, state, and status query parameters. The status filter accepts the terminal exit states (success, failed, timeout, canceled) or 'null' to match processes that have not finished.",
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
    ...rateLimitResponse(),
    409: apiErrorResponse(
      "The process is already idle or is already terminating.",
    ),
    500: apiErrorResponse("The process could not be terminated."),
  },
});

registry.registerPath({
  method: "post",
  path: "/processes",
  tags: ["Processes"],
  summary: "Create a process",
  description:
    "Creates a new process with the supplied source code and optional execution options. If autorun is true (the default), the process begins execution immediately.",
  request: {
    body: { content: jsonContent(ProcessCreateRequestSchema) },
  },
  responses: {
    201: {
      description: "Process created.",
      content: jsonContent(ProcessCreatedResponseSchema),
    },
    400: apiErrorResponse("The request body could not be parsed."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    500: apiErrorResponse("The process could not be created."),
  },
});

registry.registerPath({
  method: "get",
  path: "/processes/{id}",
  tags: ["Processes"],
  summary: "Get a process",
  description: "Returns a single process snapshot by its numeric identifier.",
  request: { params: idParam },
  responses: {
    200: {
      description: "Process snapshot.",
      content: jsonContent(ProcessSchema),
    },
    400: apiErrorResponse("The id path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The process could not be found."),
    ...rateLimitResponse(),
    500: apiErrorResponse("The process could not be loaded."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/processes/{id}",
  tags: ["Processes"],
  summary: "Delete a process",
  description:
    "Deletes a process and its associated data (code, output, stdout, stderr).",
  request: { params: idParam },
  responses: {
    200: {
      description: "The process was deleted successfully.",
      content: jsonContent(ProcessSchema),
    },
    400: apiErrorResponse("The id path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    404: apiErrorResponse("The process could not be found."),
    409: apiErrorResponse("The process is not idle and could not be deleted."),
    500: apiErrorResponse("The process could not be deleted."),
  },
});

registry.registerPath({
  method: "get",
  path: "/processes/{id}/code",
  tags: ["Processes"],
  summary: "Get process source code",
  description: "Returns the source code submitted for the process.",
  request: { params: idParam },
  responses: {
    200: {
      description: "Source code of the process.",
      content: textContent(
        z.string().describe("Source code submitted for the process."),
        "text/plain",
      ),
    },
    400: apiErrorResponse("The id path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The process could not be found."),
    ...rateLimitResponse(),
    500: apiErrorResponse("The source code could not be loaded."),
  },
});

registry.registerPath({
  method: "get",
  path: "/processes/{id}/output",
  tags: ["Processes"],
  summary: "Get process output",
  description:
    "Returns the structured JSON output emitted by the process during execution.",
  request: { params: idParam },
  responses: {
    200: {
      description: "Structured output of the process.",
      content: jsonContent(ProcessOutputSchema),
    },
    400: apiErrorResponse("The id path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The process could not be found."),
    ...rateLimitResponse(),
    500: apiErrorResponse("The process output could not be loaded."),
  },
});

registry.registerPath({
  method: "get",
  path: "/processes/{id}/stdout",
  tags: ["Processes"],
  summary: "Get process stdout",
  description: "Returns the captured standard output text of the process.",
  request: { params: idParam },
  responses: {
    200: {
      description: "Standard output of the process.",
      content: textContent(
        z.string().describe("Captured stdout text of the process."),
        "text/plain",
      ),
    },
    400: apiErrorResponse("The id path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The process could not be found."),
    ...rateLimitResponse(),
    500: apiErrorResponse("The process stdout could not be loaded."),
  },
});

registry.registerPath({
  method: "get",
  path: "/processes/{id}/stderr",
  tags: ["Processes"],
  summary: "Get process stderr",
  description: "Returns the captured standard error text of the process.",
  request: { params: idParam },
  responses: {
    200: {
      description: "Standard error of the process.",
      content: textContent(
        z.string().describe("Captured stderr text of the process."),
        "text/plain",
      ),
    },
    400: apiErrorResponse("The id path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The process could not be found."),
    ...rateLimitResponse(),
    500: apiErrorResponse("The process stderr could not be loaded."),
  },
});

registry.registerPath({
  method: "post",
  path: "/processes/{id}/signals/run",
  tags: ["Processes"],
  summary: "Send run signal",
  description:
    "Dispatches a run signal to an idle process, optionally forcing a re-run even if prior output exists.",
  request: {
    params: idParam,
    body: { content: jsonContent(RunSignalRequestSchema) },
  },
  responses: {
    200: {
      description: "The process was started or restarted.",
      content: jsonContent(ProcessSchema),
    },
    400: apiErrorResponse("The request body or id path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The process could not be found."),
    ...rateLimitResponse(),
    409: apiErrorResponse(
      "The process is already idle or is already terminating.",
    ),
    500: apiErrorResponse("The process could not be started."),
  },
});

registry.registerPath({
  method: "post",
  path: "/processes/{id}/signals/kill",
  tags: ["Processes"],
  summary: "Send kill signal",
  description:
    "Stops a queued or running process by id, returning the updated process record.",
  request: {
    params: idParam,
    body: { content: jsonContent(ProcessKillRequestSchema) },
  },
  responses: {
    200: {
      description: "The process was stopped.",
      content: jsonContent(ProcessSchema),
    },
    400: apiErrorResponse("The request body or id path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The process could not be found."),
    ...rateLimitResponse(),
    409: apiErrorResponse(
      "The process is already idle or is already terminating.",
    ),
    500: apiErrorResponse("The process could not be terminated."),
  },
});

registry.registerPath({
  method: "post",
  path: "/processes/{id}/signals/unload",
  tags: ["Processes"],
  summary: "Send unload signal",
  description:
    "Removes an idle process from active memory, keeping its database record and outputs intact. The process id remains valid and can be revived later via the run signal. Returns a conflict when the process is not idle or is not in active memory.",
  request: {
    params: idParam,
    body: { content: jsonContent(ProcessKillRequestSchema) },
  },
  responses: {
    200: {
      description: "The process was unloaded from active memory.",
      content: jsonContent(ProcessSchema),
    },
    400: apiErrorResponse("The request body or id path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The process could not be found."),
    ...rateLimitResponse(),
    409: apiErrorResponse(
      "The process is not idle or is not in active memory.",
    ),
    500: apiErrorResponse("The process could not be unloaded."),
  },
});

registry.registerPath({
  method: "get",
  path: "/services",
  tags: ["Services"],
  summary: "List services",
  description:
    "Returns the installed services. The query parameter is trimmed and matched against service id, name, and description. The enabled and stale parameters accept 'true' or 'false'; omit either to return all services.",
  request: {
    query: z.object({
      query: z
        .string()
        .optional()
        .describe(
          "Free-text query used to match service id, name, and description.",
        ),
      enabled: booleanQuerySchema
        .optional()
        .describe("Enabled-state filter. Omit to return all services."),
      stale: booleanQuerySchema
        .optional()
        .describe(
          "Stale-state filter. true = stale only, false = fresh only. Omit to return all services.",
        ),
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
    ...rateLimitResponse(),
    500: apiErrorResponse("The service list could not be loaded."),
  },
});

registry.registerPath({
  method: "get",
  path: "/services/{serviceId}",
  tags: ["Services"],
  summary: "Get a service",
  description:
    "Returns full manifest metadata for a service, including configuration and secrets schemas.",
  request: { params: serviceIdParam },
  responses: {
    200: {
      description: "Service details.",
      content: jsonContent(ServiceDetailsSchema),
    },
    400: apiErrorResponse("The serviceId path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    404: apiErrorResponse("The service could not be found."),
    500: apiErrorResponse("The service details could not be loaded."),
  },
});

registry.registerPath({
  method: "post",
  path: "/services",
  tags: ["Services"],
  summary: "Install a service from a direct URL",
  description:
    "Downloads the definition file from the supplied direct URL, validates the manifest, and stores it as a new service under the supplied id and adapter. No registry source is stored.",
  request: {
    body: { content: jsonContent(ServiceDirectInstallRequestSchema) },
  },
  responses: {
    201: {
      description: "The service was installed and stored.",
      content: jsonContent(ServiceCreatedResponseSchema),
    },
    400: apiErrorResponse(
      "The install payload was invalid or the downloaded definition failed validation.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    409: apiErrorResponse("A service already exists with the requested id."),
    413: apiErrorResponse(
      "The downloaded definition exceeded the configured size limit.",
    ),
    502: apiErrorResponse("The definition file could not be downloaded."),
    500: apiErrorResponse("The service could not be installed."),
  },
});

registry.registerPath({
  method: "post",
  path: "/services/install",
  tags: ["Services"],
  summary: "Install a service from a registry",
  description:
    "Resolves the registry source URL, downloads the definition from the returned downloadUrl, validates the manifest, and stores it. Optional adapter and id override the registry defaults. The registry source URL is stored for future updates.",
  request: { body: { content: jsonContent(ServiceInstallRequestSchema) } },
  responses: {
    201: {
      description: "The service was installed and stored.",
      content: jsonContent(ServiceCreatedResponseSchema),
    },
    400: apiErrorResponse(
      "The install payload was invalid, the registry response was malformed, or the downloaded definition failed validation.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    409: apiErrorResponse("A service already exists with the requested id."),
    413: apiErrorResponse(
      "The downloaded definition exceeded the configured size limit.",
    ),
    502: apiErrorResponse(
      "The registry or definition file could not be downloaded.",
    ),
    500: apiErrorResponse("The service could not be installed."),
  },
});

registry.registerPath({
  method: "post",
  path: "/services/{serviceId}/update",
  tags: ["Services"],
  summary: "Update a service from its stored registry",
  description:
    "Re-resolves the stored registry source URL, compares the registry hash against the stored hash, and re-downloads and re-installs the definition if changed. Only works for registry-installed services.",
  request: { params: serviceIdParam },
  responses: {
    200: {
      description: "Update result for the requested service.",
      content: jsonContent(ServiceUpdateResponseSchema),
    },
    400: apiErrorResponse(
      "The serviceId path parameter or downloaded definition was invalid.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The service could not be found."),
    ...rateLimitResponse(),
    409: apiErrorResponse(
      "The service has no stored registry source and cannot be updated automatically.",
    ),
    413: apiErrorResponse(
      "The downloaded definition exceeded the configured size limit.",
    ),
    502: apiErrorResponse(
      "The registry or definition file could not be downloaded.",
    ),
    500: apiErrorResponse("The service could not be updated."),
  },
});

registry.registerPath({
  method: "post",
  path: "/services/{serviceId}/sync",
  tags: ["Services"],
  summary: "Sync a service from its stored definition",
  description:
    "Re-registers a service from its stored definition content without re-downloading. This is used to reconcile the service with its adapter after the adapter was updated or the service was marked stale. The service is disabled after sync to allow the user to re-enable once configuration and secrets are verified.",
  request: { params: serviceIdParam },
  responses: {
    200: {
      description: "Service synced successfully.",
      content: jsonContent(ServiceSyncResponseSchema),
    },
    400: apiErrorResponse("The serviceId path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The service could not be found."),
    ...rateLimitResponse(),
    409: apiErrorResponse(
      "The service is stale or has no stored definition content to sync from.",
    ),
    500: apiErrorResponse("The service could not be synced."),
  },
});

registry.registerPath({
  method: "patch",
  path: "/services/{serviceId}",
  tags: ["Services"],
  summary: "Replace a service via direct URL",
  description:
    "Downloads the definition file from the supplied direct URL and replaces the existing service. The stored registry source is cleared, making the service a direct-installed item.",
  request: {
    params: serviceIdParam,
    body: { content: jsonContent(ServicePatchRequestSchema) },
  },
  responses: {
    200: {
      description: "Update result for the requested service.",
      content: jsonContent(ServicePatchResponseSchema),
    },
    400: apiErrorResponse(
      "The serviceId path parameter or request body was invalid.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The service could not be found."),
    ...rateLimitResponse(),
    413: apiErrorResponse(
      "The downloaded definition exceeded the configured size limit.",
    ),
    502: apiErrorResponse("The definition file could not be downloaded."),
    500: apiErrorResponse("The service could not be updated."),
  },
});

registry.registerPath({
  method: "post",
  path: "/services/{serviceId}/enabled",
  tags: ["Services"],
  summary: "Toggle a service",
  description:
    "Sets whether a service is enabled. When enabling, the stored configuration and secrets are validated against their schemas before the change is persisted and the service is hydrated on its adapter.",
  request: {
    params: serviceIdParam,
    body: { content: jsonContent(ServiceEnabledRequestSchema) },
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
    404: apiErrorResponse("The service could not be found."),
    ...rateLimitResponse(),
    502: apiErrorResponse(
      "The service could not be hydrated on its adapter module.",
    ),
    500: apiErrorResponse("The service enabled state could not be updated."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/services/{serviceId}",
  tags: ["Services"],
  summary: "Delete a service",
  description:
    "Deletes a service manifest along with its tools, configuration, and secrets. The owning adapter is asked to dehydrate the service afterwards.",
  request: { params: serviceIdParam },
  responses: {
    204: { description: "The service was deleted successfully." },
    400: apiErrorResponse("The serviceId path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    404: apiErrorResponse("The service could not be found."),
    500: apiErrorResponse("The service could not be deleted."),
  },
});

registry.registerPath({
  method: "get",
  path: "/services/{serviceId}/config/schema",
  tags: ["Services"],
  summary: "Get a service configuration schema",
  description:
    "Returns the JSON Schema used to validate the service configuration payload.",
  request: { params: serviceIdParam },
  responses: {
    200: {
      description: "Configuration schema document.",
      content: jsonContent(ServiceConfigurationSchemaResponseSchema),
    },
    400: apiErrorResponse("The serviceId path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The service could not be found."),
    ...rateLimitResponse(),
    500: apiErrorResponse("The configuration schema could not be loaded."),
  },
});

registry.registerPath({
  method: "get",
  path: "/services/{serviceId}/config",
  tags: ["Services"],
  summary: "Get service configuration",
  description:
    "Returns the configuration payload stored for the service. If no configuration exists yet, an empty object is returned.",
  request: { params: serviceIdParam },
  responses: {
    200: {
      description: "Current service configuration.",
      content: jsonContent(ServiceConfigurationResponseSchema),
    },
    400: apiErrorResponse("The serviceId path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    500: apiErrorResponse("The configuration could not be loaded."),
  },
});

registry.registerPath({
  method: "patch",
  path: "/services/{serviceId}/config",
  tags: ["Services"],
  summary: "Patch service configuration",
  description:
    "Applies a JSON Patch document to the stored configuration, validates the result against the schema, persists it, and returns the resulting configuration payload. The patch body must be an array of RFC 6902 operations.",
  request: {
    params: serviceIdParam,
    body: { content: jsonContent(patchBodySchema) },
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
    404: apiErrorResponse("The service could not be found."),
    ...rateLimitResponse(),
    500: apiErrorResponse("The configuration could not be persisted."),
  },
});

registry.registerPath({
  method: "get",
  path: "/services/{serviceId}/secrets",
  tags: ["Services"],
  summary: "Get service secrets presence",
  description:
    "Returns the list of secrets paths that currently have values set. Secrets values are never echoed back, only their presence or absence is exposed.",
  request: { params: serviceIdParam },
  responses: {
    200: {
      description: "List of secrets paths with values present.",
      content: jsonContent(ServiceSecretsPresenceResponseSchema),
    },
    400: apiErrorResponse("The serviceId path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The service could not be found."),
    ...rateLimitResponse(),
    500: apiErrorResponse("The secrets presence could not be determined."),
  },
});

registry.registerPath({
  method: "get",
  path: "/services/{serviceId}/secrets/schema",
  tags: ["Services"],
  summary: "Get a service secrets schema",
  description:
    "Returns the JSON Schema used to validate the service secrets payload.",
  request: { params: serviceIdParam },
  responses: {
    200: {
      description: "Secrets schema document.",
      content: jsonContent(ServiceSecretsSchemaResponseSchema),
    },
    400: apiErrorResponse("The serviceId path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The service could not be found."),
    ...rateLimitResponse(),
    500: apiErrorResponse("The secrets schema could not be loaded."),
  },
});

registry.registerPath({
  method: "patch",
  path: "/services/{serviceId}/secrets",
  tags: ["Services"],
  summary: "Patch service secrets",
  description:
    "Applies a JSON Patch document to the encrypted secrets payload, validates the result against the schema, and persists the updated secrets. The response only confirms success; secrets are never echoed back.",
  request: {
    params: serviceIdParam,
    body: { content: jsonContent(patchBodySchema) },
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
    404: apiErrorResponse("The service could not be found."),
    ...rateLimitResponse(),
    500: apiErrorResponse("The secrets could not be persisted."),
  },
});

registry.registerPath({
  method: "get",
  path: "/tools",
  tags: ["Tools"],
  summary: "List tools",
  description:
    "Returns tools that match the supplied filters. The serviceId, query, limit, and enabled query parameters are all optional. The enabled filter accepts 'true' or 'false'.",
  request: {
    query: z.object({
      serviceId: z
        .string()
        .optional()
        .describe("Optional service identifier used to scope tool results."),
      query: z
        .string()
        .optional()
        .describe("Free-text query used to match tool names and descriptions."),
      limit: z
        .string()
        .optional()
        .describe(
          "Maximum number of matching tools to return, as a positive integer string.",
        ),
      enabled: booleanQuerySchema
        .optional()
        .describe("Enabled-state filter. Omit to return all tools."),
    }),
  },
  responses: {
    200: {
      description: "Matching tools.",
      content: jsonContent(ToolListResponseSchema),
    },
    400: apiErrorResponse("One or more query parameters could not be parsed."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    500: apiErrorResponse("The tool list could not be loaded."),
  },
});

registry.registerPath({
  method: "get",
  path: "/tools/{serviceId}/{toolId}",
  tags: ["Tools"],
  summary: "Get a tool",
  description:
    "Returns detailed metadata for a tool within a service, including input and output schemas.",
  request: { params: serviceToolParams },
  responses: {
    200: {
      description: "Tool details.",
      content: jsonContent(ToolDetailsSchema),
    },
    400: apiErrorResponse(
      "The serviceId or toolId path parameter was invalid.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The service or tool could not be found."),
    ...rateLimitResponse(),
    500: apiErrorResponse("The tool details could not be loaded."),
  },
});

registry.registerPath({
  method: "get",
  path: "/tools/{serviceId}/{toolId}/docs",
  tags: ["Tools"],
  summary: "Get tool documentation",
  description:
    "Returns generated documentation for the tool as Markdown text. Documentation is produced by the active environment module.",
  request: { params: serviceToolParams },
  responses: {
    200: {
      description: "Markdown documentation for the tool.",
      content: textContent(
        z.string().describe("Tool documentation rendered as Markdown."),
        "text/markdown",
      ),
    },
    400: apiErrorResponse(
      "The serviceId or toolId path parameter was invalid.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The service or tool could not be found."),
    ...rateLimitResponse(),
    500: apiErrorResponse("The tool documentation could not be generated."),
  },
});

registry.registerPath({
  method: "post",
  path: "/tools/{serviceId}/{toolId}/enabled",
  tags: ["Tools"],
  summary: "Toggle a tool",
  description:
    "Sets whether a tool is enabled. The parent service can still disable the tool at runtime even if the stored tool flag is true.",
  request: {
    params: serviceToolParams,
    body: { content: jsonContent(ToolEnabledRequestSchema) },
  },
  responses: {
    200: {
      description: "Updated tool enabled state.",
      content: jsonContent(ToolEnabledResponseSchema),
    },
    400: apiErrorResponse("The request body or path parameters were invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The tool could not be found."),
    ...rateLimitResponse(),
    500: apiErrorResponse("The tool enabled state could not be updated."),
  },
});

registry.registerPath({
  method: "get",
  path: "/modules",
  tags: ["Modules"],
  summary: "List modules",
  description:
    "Returns module manifests filtered by optional query, type, isBuiltin, enabled, and missing query parameters.",
  request: {
    query: z.object({
      query: z
        .string()
        .optional()
        .describe(
          "Free-text query used to match module names and descriptions.",
        ),
      type: moduleTypeSchema.optional(),
      isBuiltin: booleanQuerySchema
        .optional()
        .describe("Filter by whether the module is bundled with the API."),
      enabled: moduleEnabledQuerySchema
        .optional()
        .describe("Enabled-state filter for modules."),
      missing: booleanQuerySchema
        .optional()
        .describe("Filter by whether the module is missing its factory."),
    }),
  },
  responses: {
    200: {
      description: "Matching modules.",
      content: jsonContent(ModuleListResponseSchema),
    },
    400: apiErrorResponse("One or more query parameters could not be parsed."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    500: apiErrorResponse("The module list could not be loaded."),
  },
});

registry.registerPath({
  method: "post",
  path: "/modules/reload",
  tags: ["Modules"],
  summary: "Reload modules",
  description:
    "Reloads the on-disk module registry. The active environment is drained and the adapter pool is reconciled against the new manifests.",
  responses: {
    200: { description: "The module registry was reloaded successfully." },
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    500: apiErrorResponse("The modules could not be reloaded."),
  },
});

registry.registerPath({
  method: "get",
  path: "/modules/{moduleId}",
  tags: ["Modules"],
  summary: "Get a module",
  description:
    "Returns the module manifest record for the requested module id, including hash, source, and configuration/secrets schemas.",
  request: { params: moduleIdParam },
  responses: {
    200: {
      description: "Full module manifest record.",
      content: jsonContent(ModuleDetailsSchema),
    },
    400: apiErrorResponse("The moduleId path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    404: apiErrorResponse("The module could not be found."),
    500: apiErrorResponse("The module could not be loaded."),
  },
});

registry.registerPath({
  method: "post",
  path: "/modules",
  tags: ["Modules"],
  summary: "Install a module from a direct URL",
  description:
    "Downloads a .tar.zst archive from the supplied direct URL, validates the module.json manifest, and registers the module. Newly installed modules start disabled by default. No registry source is stored.",
  request: { body: { content: jsonContent(ModuleDirectInstallRequestSchema) } },
  responses: {
    201: {
      description: "The module manifest record for the newly installed module.",
      content: jsonContent(ModuleDetailsSchema),
    },
    400: apiErrorResponse(
      "The request body was invalid or the archive failed validation.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    409: apiErrorResponse("A module already exists with the requested id."),
    413: apiErrorResponse(
      "The downloaded archive exceeded the configured size limit.",
    ),
    502: apiErrorResponse("The archive file could not be downloaded."),
    500: apiErrorResponse("The module could not be installed."),
  },
});

registry.registerPath({
  method: "post",
  path: "/modules/install",
  tags: ["Modules"],
  summary: "Install a module from a registry",
  description:
    "Resolves the registry source URL, downloads the .tar.zst archive from the returned downloadUrl, validates the module.json manifest, and registers the module. The registry source URL is stored for future updates via POST /modules/:id/update.",
  request: { body: { content: jsonContent(ModuleInstallRequestSchema) } },
  responses: {
    201: {
      description: "The module manifest record for the newly installed module.",
      content: jsonContent(ModuleDetailsSchema),
    },
    400: apiErrorResponse(
      "The request body was invalid, the registry response was malformed, or the archive failed validation.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    409: apiErrorResponse("A module already exists with the requested id."),
    413: apiErrorResponse(
      "The downloaded archive exceeded the configured size limit.",
    ),
    502: apiErrorResponse(
      "The registry or archive file could not be downloaded.",
    ),
    500: apiErrorResponse("The module could not be installed."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/modules/{moduleId}",
  tags: ["Modules"],
  summary: "Delete a module",
  description:
    "Deactivates the module's adapter or environment, deletes its database record, and removes its filesystem directory. Services belonging to the module are also removed.",
  request: { params: moduleIdParam },
  responses: {
    204: { description: "The module was deleted successfully." },
    400: apiErrorResponse("The moduleId path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    404: apiErrorResponse("The module could not be found."),
    500: apiErrorResponse("The module could not be deleted."),
  },
});

registry.registerPath({
  method: "post",
  path: "/modules/{moduleId}/update",
  tags: ["Modules"],
  summary: "Update a module from its stored registry",
  description:
    "Re-resolves the stored registry source URL, compares the registry hash against the stored hash, and re-downloads and re-installs the archive if changed. Returns updated: false when the archive is unchanged. Only works for registry-installed modules. After a successful archive replacement every non-missing service targeting this adapter is regenerated via the new module's generateDefinition. Services that fail regeneration are marked stale and cannot be invoked until synced.",
  request: { params: moduleIdParam },
  responses: {
    200: {
      description: "Update result for the requested module.",
      content: jsonContent(ModuleUpdateResponseSchema),
    },
    400: apiErrorResponse("The moduleId path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    404: apiErrorResponse("The module could not be found."),
    409: apiErrorResponse(
      "The module has no stored registry source and cannot be updated automatically.",
    ),
    413: apiErrorResponse(
      "The downloaded archive exceeded the configured size limit.",
    ),
    502: apiErrorResponse(
      "The registry or archive file could not be downloaded.",
    ),
    500: apiErrorResponse("The module could not be updated."),
  },
});

registry.registerPath({
  method: "patch",
  path: "/modules/{moduleId}",
  tags: ["Modules"],
  summary: "Replace a module via direct URL",
  description:
    "Downloads a .tar.zst archive from the supplied direct URL and replaces the existing module installation. The stored registry source is cleared, making the module a direct-installed item. After a successful archive replacement every non-missing service targeting this adapter is regenerated via the new module's generateDefinition. Services that fail regeneration are marked stale and cannot be invoked until synced.",
  request: {
    params: moduleIdParam,
    body: { content: jsonContent(ModulePatchRequestSchema) },
  },
  responses: {
    200: {
      description: "Update result for the requested module.",
      content: jsonContent(ModuleUpdateResponseSchema),
    },
    400: apiErrorResponse(
      "The moduleId path parameter or request body was invalid.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    404: apiErrorResponse("The module could not be found."),
    413: apiErrorResponse(
      "The downloaded archive exceeded the configured size limit.",
    ),
    502: apiErrorResponse("The archive file could not be downloaded."),
    500: apiErrorResponse("The module could not be updated."),
  },
});

registry.registerPath({
  method: "post",
  path: "/modules/{moduleId}/enabled",
  tags: ["Modules"],
  summary: "Toggle a module",
  description:
    "Sets whether a module is enabled. Missing modules cannot be enabled.",
  request: {
    params: moduleIdParam,
    body: { content: jsonContent(ModuleEnabledRequestSchema) },
  },
  responses: {
    200: { description: "The module enabled state was updated." },
    400: apiErrorResponse(
      "The request body or moduleId path parameter was invalid.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    404: apiErrorResponse("The module could not be found."),
    409: apiErrorResponse("The module is missing and cannot be enabled."),
    500: apiErrorResponse("The module enabled state could not be updated."),
  },
});

registry.registerPath({
  method: "get",
  path: "/environment/docs",
  tags: ["Environment"],
  summary: "Get environment documentation",
  description:
    "Returns Markdown documentation generated by the active environment module describing the runtime and the available bindings.",
  responses: {
    200: {
      description: "Markdown documentation for the active environment.",
      content: textContent(
        z.string().describe("Environment documentation rendered as Markdown."),
        "text/markdown",
      ),
    },
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    500: apiErrorResponse(
      "The environment documentation could not be generated.",
    ),
  },
});

export function generateOpenApiDoc(): OpenAPIObject {
  const generator = new OpenApiGeneratorV3(registry.definitions);

  return generator.generateDocument({
    openapi: "3.0.0",
    info: {
      title: "Cyrnel API",
      description:
        "Cyrnel is a universal layer that connects AI agents and LLM applications to any external service, API, or device regardless of protocol or standard. It acts as an adaptive bridge between your AI and the outside world, enabling seamless integrations through code execution, async operation handling, and built-in observability and security controls.",
      version: "1.0.0",
    },
    servers: [{ url: "http://localhost:9371" }],
  });
}
