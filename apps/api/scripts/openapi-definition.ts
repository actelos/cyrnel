import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from "@asteasolutions/zod-to-openapi";
import type { OpenAPIObject } from "openapi3-ts/oas30";
import { z } from "zod";
import {
  createLogEntrySchema,
  LOG_LEVELS,
  LOG_TYPES,
} from "../src/infra/logging/log-entry";
import { MODULE_TYPES } from "../src/models/modules.model";
import {
  PROCESS_EXIT_STATES,
  PROCESS_STATES,
} from "../src/models/process.model";
import {
  PAGINATION_CURSOR_MAX_LENGTH,
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
} from "../src/utils/pagination.util";

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

const paginationQuerySchema = z.object({
  cursor: z
    .string()
    .max(PAGINATION_CURSOR_MAX_LENGTH)
    .optional()
    .describe(
      "Opaque pagination token returned as nextCursor by the previous response. Pass it back unchanged to fetch the next page; null/omitted fetches the first page. Cursors encode position, not filters, so change filters only between pages when starting over.",
    ),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGINATION_MAX_LIMIT)
    .default(PAGINATION_DEFAULT_LIMIT)
    .describe(
      "Maximum number of items per page. Clamped to a maximum of 100; defaults to 20.",
    ),
});

function paginatedResponseSchema(
  name: string,
  itemSchema: z.ZodTypeAny,
  itemsDescription: string,
) {
  return registry.register(
    name,
    z
      .object({
        items: z.array(itemSchema).describe(itemsDescription),
        nextCursor: z
          .string()
          .nullable()
          .describe(
            "Opaque cursor for the next page; null when there are no more items. Echo it back as the cursor query parameter to continue paginating.",
          ),
        hasMore: z
          .boolean()
          .describe(
            "Whether additional pages exist. When true, nextCursor is a valid cursor; when false, pagination has reached the end.",
          ),
      })
      .describe("Paginated collection envelope."),
  );
}

const ApiErrorResponseSchema = registry.register(
  "ApiErrorResponse",
  z
    .object({
      error: z
        .string()
        .describe("Human-readable error message returned by the API."),
      code: z
        .string()
        .optional()
        .describe(
          "Stable machine-readable error code (e.g. invalid_cursor, cursor_expired).",
        ),
    })
    .describe("Standard error envelope returned by the HTTP error middleware."),
);

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
      pid: z
        .number()
        .int()
        .positive()
        .nullable()
        .describe(
          "Ephemeral in-memory process identifier, or null when the process is not in active memory.",
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

const ProcessListResponseSchema = paginatedResponseSchema(
  "ProcessListResponse",
  ProcessSchema,
  "Processes that match the provided query filters.",
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
      hasIcon: z
        .boolean()
        .describe("Whether the service has a registry-declared icon."),
      createdAt: z
        .string()
        .describe("ISO-8601 timestamp of when the service was installed."),
      autoUpdate: z
        .boolean()
        .describe(
          "Whether the service opted into the background auto-update sweep.",
        ),
      autoUpdateConstraint: z
        .string()
        .nullable()
        .describe(
          "Semver range pinning the auto-update registry version, or null for latest.",
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

const ServiceListResponseSchema = paginatedResponseSchema(
  "ServiceListResponse",
  ServiceListItemSchema,
  "Services that match the supplied filters.",
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
          "Optional adapter module identifier. Overrides the resolver-selected adapter.",
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
      autoUpdate: z
        .boolean()
        .optional()
        .describe(
          "Whether to auto-update this service with the registry source it is installed from. Defaults to true.",
        ),
    })
    .describe("Request body used to install a service from a registry."),
);

const AdapterRankListItemSchema = registry.register(
  "AdapterRankListItem",
  z.object({
    id: z.string().describe("Adapter module identifier."),
    name: z.string().describe("Human-readable adapter module name."),
    compatible: z
      .boolean()
      .describe("Whether the adapter accepts the requested definition kind."),
    active: z
      .boolean()
      .describe(
        "Whether the adapter module is currently installed and active.",
      ),
    isBuiltin: z
      .boolean()
      .describe(
        "Whether the adapter is a built-in (canonical) module, preferred on ranking ties.",
      ),
  }),
);

const InstallAdaptersResponseSchema = registry.register(
  "InstallAdaptersResponse",
  z.object({
    default: z
      .string()
      .nullable()
      .describe(
        "Default adapter id (compatible and active). Null when no compatible adapter is available.",
      ),
    adapters: z
      .array(AdapterRankListItemSchema)
      .describe(
        "All installed adapter modules, ranked so compatible adapters come first.",
      ),
  }),
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
      autoUpdate: z
        .boolean()
        .optional()
        .describe(
          "Whether to auto-update this service with the definition URL it was installed from. Defaults to true.",
        ),
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

const ServiceAutoUpdateRequestSchema = registry.register(
  "ServiceAutoUpdateRequest",
  z
    .object({
      autoUpdate: z
        .boolean()
        .describe(
          "Whether the service opts into the background auto-update sweep.",
        ),
      constraint: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Optional semver range pinning which registry version is selected. Omitted or null means latest. Invalid ranges are rejected with 400.",
        ),
    })
    .describe("Request body used to opt a service into auto-updates."),
);

const ServiceAutoUpdateResponseSchema = registry.register(
  "ServiceAutoUpdateResponse",
  z
    .object({
      id: z
        .string()
        .min(1)
        .describe("Identifier of the service whose auto-update flag was set."),
      autoUpdate: z.boolean().describe("The stored auto-update opt-in state."),
      constraint: z
        .string()
        .nullable()
        .describe(
          "The normalized semver range stored for the sweep, or null for latest.",
        ),
    })
    .describe("Response returned by the service auto-update endpoint."),
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
        "Current configuration payload stored for the service, projected to keys defined by the schema.",
      ),
      outdated: z
        .array(z.string())
        .describe(
          "RFC 6901 pointers of stored configuration values that are no longer defined by the schema.",
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
      outdated: z
        .array(z.string())
        .describe(
          "RFC 6901 pointers of stored secret values that are no longer defined by the schema.",
        ),
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
      summary: z
        .string()
        .describe("Tool summary declared by the tool definition."),
      enabled: z
        .boolean()
        .describe("Whether the tool is enabled at the manifest level."),
      effectivelyEnabled: z
        .boolean()
        .describe(
          "Whether the tool is callable after accounting for its parent service state.",
        ),
      score: z
        .number()
        .optional()
        .describe(
          "Relevance score (reciprocal rank fusion of the FTS5 and vector ranks); present only when a query was supplied.",
        ),
      matchType: z
        .enum(["fts", "vector", "both"])
        .optional()
        .describe(
          "Which search signals matched the tool: FTS5 text match, vector similarity, or both.",
        ),
      ftsRank: z
        .number()
        .int()
        .optional()
        .describe(
          "Rank of the tool in the FTS5 result list (1-based); present only when matched by FTS5.",
        ),
      vectorRank: z
        .number()
        .int()
        .optional()
        .describe(
          "Rank of the tool in the vector result list (1-based); present only when matched by the embedding model.",
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

const ToolListResponseSchema = paginatedResponseSchema(
  "ToolListResponse",
  ToolListItemSchema,
  "Tools that match the supplied filters.",
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
      hasIcon: z
        .boolean()
        .describe("Whether the module has a registry-declared icon."),
      createdAt: z
        .string()
        .describe("ISO-8601 timestamp of when the module was installed."),
      autoUpdate: z
        .boolean()
        .describe(
          "Whether the module opted into the background auto-update sweep.",
        ),
      autoUpdateConstraint: z
        .string()
        .nullable()
        .describe(
          "Semver range pinning the auto-update registry version, or null for latest.",
        ),
    })
    .describe("Module manifest record returned by the modules endpoints."),
);

const ModuleListResponseSchema = paginatedResponseSchema(
  "ModuleListResponse",
  ModuleSchema,
  "Modules that match the supplied query filters.",
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
      autoUpdate: z
        .boolean()
        .optional()
        .describe(
          "Whether to auto-update this module with the registry source it is installed from. Defaults to true.",
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
      autoUpdate: z
        .boolean()
        .optional()
        .describe(
          "Whether to auto-update this module with the archive URL it was installed from. Defaults to true.",
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

const ModuleAutoUpdateRequestSchema = registry.register(
  "ModuleAutoUpdateRequest",
  z
    .object({
      autoUpdate: z
        .boolean()
        .describe(
          "Whether the module opts into the background auto-update sweep.",
        ),
      constraint: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Optional semver range pinning which registry version is selected. Omitted or null means latest. Invalid ranges are rejected with 400.",
        ),
    })
    .describe("Request body used to opt a module into auto-updates."),
);

const ModuleAutoUpdateResponseSchema = registry.register(
  "ModuleAutoUpdateResponse",
  z
    .object({
      id: z
        .string()
        .min(1)
        .describe("Identifier of the module whose auto-update flag was set."),
      autoUpdate: z.boolean().describe("The stored auto-update opt-in state."),
      constraint: z
        .string()
        .nullable()
        .describe(
          "The normalized semver range stored for the sweep, or null for latest.",
        ),
    })
    .describe("Response returned by the module auto-update endpoint."),
);

const ModuleEnabledRequestSchema = registry.register(
  "ModuleEnabledRequest",
  z
    .object({
      enabled: z.boolean().describe("Desired enabled state for the module."),
    })
    .describe("Request body used to toggle a module enabled state."),
);

const RegistrySchema = registry.register(
  "Registry",
  z
    .object({
      id: z
        .string()
        .min(1)
        .describe(
          "Registry slug matching /^[A-Za-z0-9_-]+$/ used as the primary key.",
        ),
      baseUrl: z
        .string()
        .describe("Normalized absolute http(s) URL of the registry."),
      lastSyncedAt: z
        .string()
        .nullable()
        .describe(
          "ISO-8601 timestamp of the last successful sync with the registry, or null when it has never been synced.",
        ),
      createdAt: z
        .string()
        .describe("ISO-8601 timestamp of when the registry was registered."),
      updatedAt: z
        .string()
        .describe("ISO-8601 timestamp of the last mutation to the record."),
      authType: z
        .enum(["apiKey", "oauth2"])
        .nullable()
        .describe(
          "Authentication method configured for this registry, or null when none is set.",
        ),
      tokenExpiresAt: z
        .number()
        .nullable()
        .describe(
          "Epoch-ms timestamp when the cached OAuth2 access token expires, or null for api key auth or when no token has been fetched.",
        ),
    })
    .describe("Record of a registered registry."),
);

const ApiKeyAuthSetupSchema = registry.register(
  "ApiKeyAuthSetup",
  z
    .object({
      type: z
        .literal("apiKey")
        .describe("API key authentication; the key is sent in a fixed header."),
      apiKey: z
        .string()
        .min(1)
        .describe(
          "API key sent in the header named by the registry's well-known auth advertisement.",
        ),
    })
    .describe("API key credentials for a registry."),
);

const OAuthAuthSetupSchema = registry.register(
  "OAuthAuthSetup",
  z
    .object({
      type: z
        .literal("oauth2")
        .describe("OAuth2 client-credentials authentication."),
      clientId: z.string().min(1).describe("OAuth2 client id."),
      clientSecret: z.string().min(1).describe("OAuth2 client secret."),
      scopes: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Optional requested scopes; each must be one of the scopes advertised by the registry. Defaults to all advertised scopes when omitted.",
        ),
    })
    .describe("OAuth2 client-credentials for a registry."),
);

const RegistryAuthAvailableScopeSchema = registry.register(
  "RegistryAuthAvailableScope",
  z
    .object({
      id: z.string().min(1).describe("Scope identifier."),
      description: z
        .string()
        .optional()
        .describe("Human-readable description of what the scope permits."),
    })
    .describe("A scope offered by the registry's oauth2 auth advertisement."),
);

const RegistryAuthReadResponseSchema = registry.register(
  "RegistryAuthReadResponse",
  z
    .object({
      authType: z.enum(["apiKey", "oauth2"]).nullable(),
      tokenEndpoint: z.string().nullable(),
      headerName: z.string().nullable(),
      tokenExpiresAt: z.number().nullable(),
      availableScopes: z
        .array(RegistryAuthAvailableScopeSchema)
        .describe(
          "Scopes advertised by the registry's current well-known document when it advertises oauth2 auth, regardless of whether auth is configured; empty otherwise.",
        ),
      configuredScopes: z
        .array(z.string())
        .describe("Scopes currently configured for the registry."),
    })
    .describe(
      "Current auth configuration for a registry and the oauth2 scopes its advertisement offers.",
    ),
);

const RegistryAuthSetupSchema = registry.register(
  "RegistryAuthSetup",
  z
    .discriminatedUnion("type", [ApiKeyAuthSetupSchema, OAuthAuthSetupSchema])
    .describe(
      "Credentials used when the server talks to the registry. The token endpoint (oauth2) and header name (apiKey) always come from the registry's well-known advertisement, never from this request.",
    ),
);

const RegistryAuthResultSchema = registry.register(
  "RegistryAuthResult",
  z
    .object({
      type: z.enum(["apiKey", "oauth2"]),
      status: z
        .enum(["configured", "error"])
        .describe(
          "configured when credentials were successfully stored; error when storage or validation failed.",
        ),
      headerName: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Header the api key is sent in, when the registry advertises api key auth.",
        ),
      tokenExpiresAt: z
        .number()
        .nullable()
        .optional()
        .describe(
          "Epoch-ms timestamp when the fetched access token expires, when the registry advertises oauth2.",
        ),
      message: z
        .string()
        .nullable()
        .optional()
        .describe("Human-readable detail when status is error."),
    })
    .describe("Outcome of storing credentials for a registry."),
);

const RegistryCreatedResponseSchema = registry.register(
  "RegistryCreatedResponse",
  z
    .object({
      ...RegistrySchema.shape,
      auth: RegistryAuthResultSchema.nullable()
        .optional()
        .describe(
          "Outcome of storing the credentials supplied in the request, or null when no auth was supplied.",
        ),
    })
    .describe("Response body of a registry registration request."),
);

const RegistryAuthSetupResponseSchema = registry.register(
  "RegistryAuthSetupResponse",
  z
    .object({
      auth: RegistryAuthResultSchema,
    })
    .describe("Response body of a registry auth setup request."),
);

const RegistryListResponseSchema = paginatedResponseSchema(
  "RegistryListResponse",
  RegistrySchema,
  "Registered registries ordered by creation time, newest first.",
);

const AddRegistryRequestSchema = registry.register(
  "AddRegistryRequest",
  z
    .object({
      baseUrl: z
        .string()
        .min(1)
        .describe(
          "Absolute http(s) URL of the registry. A well-known discovery document is fetched from it; the URL is normalized before storage.",
        ),
      id: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Optional local id override. When omitted, the id advertised by the registry's well-known document is used.",
        ),
      auth: RegistryAuthSetupSchema.optional().describe(
        "Optional credentials for the registry, validated against its well-known auth advertisement before storage.",
      ),
    })
    .describe("Request body used to register a registry via discovery."),
);

const RegistryEntrySchema = registry.register(
  "RegistryEntry",
  z
    .object({
      id: z.string().min(1).describe("Entry slug matching /^[A-Za-z0-9_-]+$/."),
      name: z
        .string()
        .optional()
        .describe("Display name of the entry, if provided."),
      description: z
        .string()
        .optional()
        .describe("Human-readable description, if provided."),
      source: z
        .string()
        .describe(
          "Normalized absolute URL of the entry's descriptor, on the registry's origin.",
        ),
      kind: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Definition kind hint (e.g. 'openapi@3.0'). Definitions only.",
        ),
      type: z
        .enum(MODULE_TYPES)
        .optional()
        .describe("Module type. Modules only."),
      icon: z
        .object({
          url: z.string().describe("Absolute URL of the entry icon."),
          hash: z.string().describe("Content hash of the icon, for caching."),
        })
        .optional()
        .describe("Entry icon, when advertised by the registry."),
    })
    .describe("One advertised service definition or module."),
);

const RegistryDefinitionsPageSchema = registry.register(
  "RegistryDefinitionsPage",
  z
    .object({
      definitions: z
        .array(RegistryEntrySchema)
        .describe(
          "Service definitions on this page, as served by the registry.",
        ),
      nextCursor: z
        .string()
        .nullable()
        .describe(
          "Opaque cursor for the next page, echoed back to the registry; null when the page is the last one.",
        ),
    })
    .describe("One page of advertised service definitions."),
);

const RegistryModulesPageSchema = registry.register(
  "RegistryModulesPage",
  z
    .object({
      modules: z
        .array(RegistryEntrySchema)
        .describe("Modules on this page, as served by the registry."),
      nextCursor: z
        .string()
        .nullable()
        .describe(
          "Opaque cursor for the next page, echoed back to the registry; null when the page is the last one.",
        ),
    })
    .describe("One page of advertised modules."),
);

const RegistryBrowseQuerySchema = z.object({
  query: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Free-text search forwarded to the registry; matching semantics are registry-defined.",
    ),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Opaque cursor returned as nextCursor by the previous page. Passed through to the registry unchanged.",
    ),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe(
      "Maximum entries per page; the registry may ignore it (default 50).",
    ),
});

const RegistryDefinitionsQuerySchema = RegistryBrowseQuerySchema.extend({
  kind: z
    .string()
    .min(1)
    .optional()
    .describe("Definition kind filter forwarded to the registry."),
});

const RegistryModulesQuerySchema = RegistryBrowseQuerySchema.extend({
  type: z
    .enum(MODULE_TYPES)
    .optional()
    .describe("Module type filter forwarded to the registry."),
});

const registryIdParam = z.object({
  id: z.string().min(1).describe("Registry slug identifying the registry."),
});

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
      ...paginationQuerySchema.shape,
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
      ...paginationQuerySchema.shape,
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
  method: "get",
  path: "/services/{serviceId}/icon",
  tags: ["Services"],
  summary: "Get a service icon",
  description:
    "Returns the stored service icon bytes. The response is cached for a day and carries a strong ETag derived from the icon hash, so clients can send If-None-Match to get 304 Not Modified responses. Only registry-installed services with a declared png/webp icon have one.",
  request: { params: serviceIdParam },
  responses: {
    200: {
      description: "Service icon image bytes.",
      content: {
        "image/png": { schema: { type: "string", format: "binary" } },
        "image/webp": { schema: { type: "string", format: "binary" } },
      },
      headers: {
        ETag: {
          description: "Strong validator derived from the icon hash.",
          schema: { type: "string" },
        },
        "Cache-Control": {
          description: "Public cache for one day.",
          schema: { type: "string" },
        },
      },
    },
    304: {
      description:
        "The icon is unchanged since the client's last fetch; the request carried a matching If-None-Match so no body is returned.",
      headers: {
        ETag: {
          description: "Strong validator matching the client's If-None-Match.",
          schema: { type: "string" },
        },
        "Cache-Control": {
          description: "Public cache for one day.",
          schema: { type: "string" },
        },
      },
    },
    400: apiErrorResponse("The serviceId path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    404: apiErrorResponse("The service has no stored icon."),
    500: apiErrorResponse("The service icon could not be loaded."),
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
    "Resolves the registry source URL, downloads the definition from the returned downloadUrl, validates the manifest, and stores it. Optional adapter and id override the resolver/​registry defaults; when adapter is omitted the best compatible and active adapter for the definition kind is used. The registry source URL is stored for future updates.",
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
  method: "get",
  path: "/services/install/adapters",
  tags: ["Services"],
  summary: "List adapters ranked for a definition kind",
  description:
    "Returns all installed adapter modules ranked so that adapters whose compatibility list accepts the requested kind come first, followed by incompatible adapters. The `default` field is the top-ranked compatible and active adapter, or null when none is available. Omit `kind` to receive all adapters unranked.",
  request: {
    query: z.object({
      kind: z
        .string()
        .optional()
        .describe(
          "Definition kind to rank against, e.g. 'openapi@3.0'. Omit to list all adapters.",
        ),
    }),
  },
  responses: {
    200: {
      description: "Ranked adapter list.",
      content: jsonContent(InstallAdaptersResponseSchema),
    },
    400: apiErrorResponse("The 'kind' query parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    500: apiErrorResponse("The adapter list could not be loaded."),
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
  path: "/services/{serviceId}/auto-update",
  tags: ["Services"],
  summary: "Opt a service into background auto-updates",
  description:
    "Sets whether the service is re-resolved from its stored registry source on the background auto-update sweep. The optional constraint is a semver range pinning which registry version is selected (omitted or null means latest); invalid ranges are rejected with 400. If the sweep interval is 0 the flag is still stored but nothing runs. Only works for registry-installed services.",
  request: {
    params: serviceIdParam,
    body: { content: jsonContent(ServiceAutoUpdateRequestSchema) },
  },
  responses: {
    200: {
      description: "The auto-update opt-in state.",
      content: jsonContent(ServiceAutoUpdateResponseSchema),
    },
    400: apiErrorResponse(
      "The serviceId path parameter, request body, or constraint was invalid.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The service could not be found."),
    ...rateLimitResponse(),
    409: apiErrorResponse(
      "The service has no stored registry source and cannot enable auto-update.",
    ),
    500: apiErrorResponse("The auto-update state could not be stored."),
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
    "Sets whether a service is enabled. When enabling, the stored configuration and secrets are validated against their schemas (keys no longer defined by the schema are tolerated) before the change is persisted and the service is hydrated on its adapter.",
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
    "Returns the configuration payload stored for the service. The payload is projected to keys defined by the schema; `outdated` lists RFC 6901 pointers of stored values that no longer match the schema. If no configuration exists yet, an empty object is returned.",
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
    "Applies a JSON Patch document to the stored configuration, persists it, and returns the resulting configuration payload plus `outdated` paths. Remove operations targeting paths that do not exist are ignored. Stored values that are no longer defined by the schema are preserved; adding new schema-disallowed keys is rejected. The patch body must be an array of RFC 6902 operations.",
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
    "Returns the list of secrets paths that currently have values set, plus `outdated` pointers for stored values no longer defined by the schema. Secrets values are never echoed back, only their presence or absence is exposed.",
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
    "Applies a JSON Patch document to the encrypted secrets payload, persists the updated secrets, and returns a confirmation. Remove operations targeting paths that do not exist are ignored. Stored values that are no longer defined by the schema are preserved; adding new schema-disallowed keys is rejected. The response only confirms success; secrets are never echoed back.",
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
    "Returns tools that match the supplied filters. The serviceId, query, cursor, limit, and enabled query parameters are all optional. The enabled filter accepts 'true' or 'false'.",
  request: {
    query: z.object({
      serviceId: z
        .string()
        .optional()
        .describe("Optional service identifier used to scope tool results."),
      query: z
        .string()
        .optional()
        .describe(
          "Free-text query matched against tool names, summaries, and descriptions via a hybrid FTS5 and vector index. Phrase naturally: word order, stopwords, and plural forms do not matter, and results are ranked by relevance when supplied.",
        ),
      enabled: booleanQuerySchema
        .optional()
        .describe("Enabled-state filter. Omit to return all tools."),
      ...paginationQuerySchema.shape,
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
      ...paginationQuerySchema.shape,
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
  method: "get",
  path: "/modules/{moduleId}/icon",
  tags: ["Modules"],
  summary: "Get a module icon",
  description:
    "Returns the stored module icon bytes. The response is cached for a day and carries a strong ETag derived from the icon hash, so clients can send If-None-Match to get 304 Not Modified responses. Only registry-installed modules with a declared png/webp icon have one.",
  request: { params: moduleIdParam },
  responses: {
    200: {
      description: "Module icon image bytes.",
      content: {
        "image/png": { schema: { type: "string", format: "binary" } },
        "image/webp": { schema: { type: "string", format: "binary" } },
      },
      headers: {
        ETag: {
          description: "Strong validator derived from the icon hash.",
          schema: { type: "string" },
        },
        "Cache-Control": {
          description: "Public cache for one day.",
          schema: { type: "string" },
        },
      },
    },
    304: {
      description:
        "The icon is unchanged since the client's last fetch; the request carried a matching If-None-Match so no body is returned.",
      headers: {
        ETag: {
          description: "Strong validator matching the client's If-None-Match.",
          schema: { type: "string" },
        },
        "Cache-Control": {
          description: "Public cache for one day.",
          schema: { type: "string" },
        },
      },
    },
    400: apiErrorResponse("The moduleId path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    404: apiErrorResponse("The module has no stored icon."),
    500: apiErrorResponse("The module icon could not be loaded."),
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
  method: "post",
  path: "/modules/{moduleId}/auto-update",
  tags: ["Modules"],
  summary: "Opt a module into background auto-updates",
  description:
    "Sets whether the module is re-resolved from its stored registry source on the background auto-update sweep. The optional constraint is a semver range pinning which registry version is selected (omitted or null means latest); invalid ranges are rejected with 400. If the sweep interval is 0 the flag is still stored but nothing runs. Only works for registry-installed modules.",
  request: {
    params: moduleIdParam,
    body: { content: jsonContent(ModuleAutoUpdateRequestSchema) },
  },
  responses: {
    200: {
      description: "The auto-update opt-in state.",
      content: jsonContent(ModuleAutoUpdateResponseSchema),
    },
    400: apiErrorResponse(
      "The moduleId path parameter, request body, or constraint was invalid.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The module could not be found."),
    ...rateLimitResponse(),
    409: apiErrorResponse(
      "The module has no stored registry source and cannot enable auto-update.",
    ),
    500: apiErrorResponse("The auto-update state could not be stored."),
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
  path: "/registries",
  tags: ["Registries"],
  summary: "List registries",
  description:
    "Returns registered registries in pages ordered by creation time, newest first. Page through results with the cursor query parameter returned by the previous response.",
  request: {
    query: z.object({
      ...paginationQuerySchema.shape,
    }),
  },
  responses: {
    200: {
      description: "Matching registries.",
      content: jsonContent(RegistryListResponseSchema),
    },
    400: apiErrorResponse("One or more query parameters could not be parsed."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    500: apiErrorResponse("The registry list could not be loaded."),
  },
});

registry.registerPath({
  method: "post",
  path: "/registries",
  tags: ["Registries"],
  summary: "Register a registry",
  description:
    "Discovers a registry from its base URL: fetches its well-known document, negotiates the highest supported definitions/modules capability, and stores a record. The advertised id is used unless an explicit id override is supplied. The base URL is validated and normalized before storage. When auth credentials are supplied, the well-known auth advertisement is validated first: safety refusals (plaintext transport, method mismatch, a requested oauth2 scope the registry does not advertise) fail the request with 400, while a failed live token exchange still stores the record and reports error status on the auth field.",
  request: { body: { content: jsonContent(AddRegistryRequestSchema) } },
  responses: {
    201: {
      description: "The registry record was created.",
      content: jsonContent(RegistryCreatedResponseSchema),
    },
    400: apiErrorResponse(
      "The request body was invalid, or the registry's well-known document is malformed or advertises no supported capability.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    409: apiErrorResponse(
      "A registry already exists with the requested id or base URL.",
    ),
    502: apiErrorResponse(
      "The registry could not be reached or returned a non-2xx response.",
    ),
    500: apiErrorResponse("The registry could not be created."),
  },
});

registry.registerPath({
  method: "post",
  path: "/registries/{id}/auth",
  tags: ["Registries"],
  summary: "Set registry auth",
  description:
    "Stores or replaces the credentials used when this server talks to the registry. The method must match the registry's well-known auth advertisement: a mismatch or an unsupported method fails with 400 and nothing is stored. Credentials are encrypted at rest with AES-256-GCM. For oauth2, a client-credentials token is exchanged immediately; transport policy refusals (non-https token endpoint outside the loopback/insecure-CIDR allowlist) fail with 400, while exchange failures store the credentials and report error status.",
  request: {
    params: registryIdParam,
    body: { content: jsonContent(RegistryAuthSetupSchema) },
  },
  responses: {
    200: {
      description: "The credentials were stored.",
      content: jsonContent(RegistryAuthSetupResponseSchema),
    },
    400: apiErrorResponse(
      "The request body was invalid, the method does not match the registry's advertisement, a requested scope is not advertised, or transport policy refused the credentials.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    404: apiErrorResponse("The registry could not be found."),
    502: apiErrorResponse(
      "The registry or its token endpoint could not be reached.",
    ),
    500: apiErrorResponse("The credentials could not be stored."),
  },
});

registry.registerPath({
  method: "get",
  path: "/registries/{id}/auth",
  tags: ["Registries"],
  summary: "Get registry auth",
  description:
    "Returns the currently configured auth for a registry together with the oauth2 scopes offered by its current well-known advertisement. The advertisement is fetched live; scopes are never cached.",
  request: { params: registryIdParam },
  responses: {
    200: {
      description: "The registry auth configuration.",
      content: jsonContent(RegistryAuthReadResponseSchema),
    },
    400: apiErrorResponse("The id path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The registry could not be found."),
    502: apiErrorResponse(
      "The registry's well-known document could not be reached.",
    ),
    500: apiErrorResponse("The auth configuration could not be loaded."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/registries/{id}/auth",
  tags: ["Registries"],
  summary: "Remove registry auth",
  description:
    "Deletes the stored credentials for the registry. Subsequent fetches to the registry are unauthenticated.",
  request: { params: registryIdParam },
  responses: {
    204: { description: "The credentials were deleted." },
    400: apiErrorResponse("The id path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse(
      "The registry could not be found, or it has no auth configured.",
    ),
    500: apiErrorResponse("The credentials could not be deleted."),
  },
});

registry.registerPath({
  method: "post",
  path: "/registries/{id}/refresh",
  tags: ["Registries"],
  summary: "Refresh a registry",
  description:
    "Re-fetches the registry's well-known document to confirm it is reachable and still advertises a supported capability, then stamps lastSyncedAt. The stored id is never changed, even if the registry now advertises a different one.",
  request: { params: registryIdParam },
  responses: {
    200: {
      description: "The updated registry record.",
      content: jsonContent(RegistrySchema),
    },
    400: apiErrorResponse("The id path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    404: apiErrorResponse("The registry could not be found."),
    502: apiErrorResponse(
      "The registry could not be reached, responded with a non-2xx status, or no longer advertises a supported capability.",
    ),
    500: apiErrorResponse("The registry could not be refreshed."),
  },
});

registry.registerPath({
  method: "get",
  path: "/registries/{id}/definitions",
  tags: ["Registries"],
  summary: "Browse registry definitions",
  description:
    "Returns one page of service definitions advertised by the registry, as served by its definitions capability endpoint. Filtering is advisory: query, kind and cursor are forwarded unchanged and entries are not filtered server-side.",
  request: {
    params: registryIdParam,
    query: RegistryDefinitionsQuerySchema,
  },
  responses: {
    200: {
      description: "Matching definitions.",
      content: jsonContent(RegistryDefinitionsPageSchema),
    },
    400: apiErrorResponse("One or more query parameters could not be parsed."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    404: apiErrorResponse(
      "The registry could not be found, or it does not support definitions.",
    ),
    502: apiErrorResponse(
      "The registry could not be reached or its capability endpoint returned a non-2xx response.",
    ),
    500: apiErrorResponse("The definitions could not be browsed."),
  },
});

registry.registerPath({
  method: "get",
  path: "/registries/{id}/modules",
  tags: ["Registries"],
  summary: "Browse registry modules",
  description:
    "Returns one page of modules advertised by the registry, as served by its modules capability endpoint. Filtering is advisory: query, type and cursor are forwarded unchanged and entries are not filtered server-side.",
  request: {
    params: registryIdParam,
    query: RegistryModulesQuerySchema,
  },
  responses: {
    200: {
      description: "Matching modules.",
      content: jsonContent(RegistryModulesPageSchema),
    },
    400: apiErrorResponse("One or more query parameters could not be parsed."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    404: apiErrorResponse(
      "The registry could not be found, or it does not support modules.",
    ),
    502: apiErrorResponse(
      "The registry could not be reached or its capability endpoint returned a non-2xx response.",
    ),
    500: apiErrorResponse("The modules could not be browsed."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/registries/{id}",
  tags: ["Registries"],
  summary: "Delete a registry",
  description:
    "Hard-deletes the registry record and any stored credentials for it (cascade).",
  request: { params: registryIdParam },
  responses: {
    204: { description: "The registry was deleted successfully." },
    400: apiErrorResponse("The id path parameter was invalid."),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    404: apiErrorResponse("The registry could not be found."),
    500: apiErrorResponse("The registry could not be deleted."),
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

const LogEntrySchema = registry.register("LogEntry", createLogEntrySchema());

const LogListResponseSchema = paginatedResponseSchema(
  "LogListResponse",
  LogEntrySchema,
  "Log entries that match the supplied filters, ordered by the requested sort.",
);

const logListQuerySchema = z.object({
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  level: z.enum(LOG_LEVELS).optional(),
  levelMin: z.enum(LOG_LEVELS).optional(),
  type: z.enum(LOG_TYPES).optional(),
  moduleType: z.enum(["adapter", "environment"]).optional(),
  query: z
    .string()
    .max(500)
    .optional()
    .describe("Substring filter against the entry message."),
  event: z.string().max(200).optional(),
  requestId: z.string().max(200).optional(),
  processId: z
    .union([z.coerce.number().int().positive(), z.string()])
    .optional(),
  adapterId: z.string().max(200).optional(),
  serviceId: z.string().max(200).optional(),
  moduleId: z.string().max(200).optional(),
  environmentId: z.string().max(200).optional(),
  executionId: z.coerce.number().int().positive().optional(),
  dispatchId: z.string().max(200).optional(),
  toolId: z.string().max(200).optional(),
  phase: z.string().max(200).optional(),
  statusCode: z.coerce.number().int().positive().max(599).optional(),
  durationMin: z.coerce.number().int().nonnegative().optional(),
  durationMax: z.coerce.number().int().nonnegative().optional(),
  sort: z
    .enum(["timestamp:asc", "timestamp:desc", "duration:asc", "duration:desc"])
    .optional()
    .describe("Sort order; defaults to timestamp:desc."),
  ...paginationQuerySchema.shape,
});

registry.registerPath({
  method: "get",
  path: "/logs",
  tags: ["Logs"],
  summary: "List log entries",
  description:
    "Returns log entries from the in-memory ring buffer and, when the page is short, the rotated JSONL log files on disk. Query filters apply to both sources; request payloads are scrubbed of secrets before persistence.",
  request: {
    query: logListQuerySchema,
  },
  responses: {
    200: {
      description: "Matching log entries.",
      content: jsonContent(LogListResponseSchema),
    },
    400: apiErrorResponse(
      "One or more query parameters could not be parsed, or the cursor is invalid or used with a non-timestamp:desc sort.",
    ),
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    ...rateLimitResponse(),
    500: apiErrorResponse("The log entries could not be retrieved."),
  },
});

registry.registerPath({
  method: "get",
  path: "/logs/stream",
  tags: ["Logs"],
  summary: "Stream log entries over SSE",
  description:
    "Server-sent event stream of log entries as they are emitted. Frames carry an id (<timestamp>:<seq>); clients can pass it back as the Last-Event-ID header on reconnect to receive only entries strictly newer than it.",
  request: {
    headers: z.object({
      "last-event-id": z
        .string()
        .optional()
        .describe(
          "Resume cursor; only entries strictly newer than it are replayed.",
        ),
    }),
  },
  responses: {
    200: {
      description: "Server-sent event stream of log entries.",
      content: textContent(
        z
          .string()
          .describe(
            "SSE frame: `id: <timestamp>:<seq>` + `event: log` + `data: <LogEntry>`.",
          ),
        "text/event-stream",
      ),
    },
    401: apiErrorResponse(
      "A bearer token was required but missing or invalid.",
    ),
    503: apiErrorResponse(
      "Log stream unavailable (logging disabled) or too many log stream subscribers.",
    ),
    ...rateLimitResponse(),
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
