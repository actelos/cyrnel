/**
 * Represents a JSON schema-like object used to describe
 * configuration, input, and output structures.
 */
export type JSONSchema = Record<string, unknown>;

/**
 * Defines a tool exposed by a service.
 */
export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  adapterDomain: Record<string, unknown>;
}

/**
 * Defines a service and the tools it exposes.
 */
export interface ServiceDefinition {
  name: string;
  description: string;
  configSchema: JSONSchema;
  secretsSchema: JSONSchema;
  tools: ToolDefinition[];
  adapterDomain: Record<string, unknown>;
}

// Base Module

/**
 * Context provided when initializing a module.
 */
export interface ModuleSetupContext {
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
}

/**
 * Base interface implemented by all Cyrnel modules.
 */
export interface Module {
  /**
   * Initializes the module using the provided configuration.
   *
   * @param context - Module configuration and secret values.
   * @returns A promise that resolves when initialization completes.
   * @throws Error if initialization fails.
   */
  setup(context: ModuleSetupContext): Promise<void>;

  /**
   * Releases resources held by the module.
   *
   * @returns A promise that resolves when cleanup completes.
   * @throws Error if cleanup fails.
   */
  teardown(): Promise<void>;
}

// Environment Module

/**
 * Input used when discovering services.
 */
export interface ListServiceInput {
  query?: string;
  limit?: number;
  enabled?: boolean;
}

/**
 * Service metadata returned by service discovery operations.
 */
export interface ListServiceResult extends Omit<
  ServiceDefinition,
  "configSchema" | "secretsSchema" | "tools" | "adapterDomain"
> {
  id: string;
  enabled: boolean;
}

/**
 * Input used when discovering tools.
 */
export interface ListToolInput {
  serviceId?: string;
  query?: string;
  limit?: number;
  enabled?: boolean;
}

/**
 * Tool metadata returned by tool discovery operations.
 */
export interface ListToolResult extends Omit<
  ToolDefinition,
  "inputSchema" | "outputSchema" | "adapterDomain"
> {
  serviceId: string;
  enabled: boolean;
  effectivelyEnabled: boolean;
}

/**
 * Detailed service information returned by service lookup operations.
 */
export interface GetServiceResult extends Omit<
  ServiceDefinition,
  "tools" | "adapterDomain"
> {
  enabled: boolean;
}

/**
 * Input used to retrieve a specific tool.
 */
export interface GetToolInput {
  serviceId: string;
  toolId: string;
}

/**
 * Detailed tool information returned by tool lookup operations.
 */
export interface GetToolResult extends Omit<
  ToolDefinition,
  "id" | "adapterDomain"
> {
  enabled: boolean;
}

/**
 * Input used to invoke a tool.
 */
export interface InvokeInput {
  serviceId: string;
  toolId: string;
  parameters: Record<string, unknown>;
}

/**
 * Execution states that indicate an execution is still in progress.
 */
export const EXECUTION_STATES = ["queued", "running"] as const;

/**
 * Represents an active execution state.
 */
export type ExecutionState = (typeof EXECUTION_STATES)[number];

/**
 * Provides environment-specific bindings used by environment modules
 * to discover services, invoke tools, and emit execution events.
 */
export interface EnvironmentBindings {
  /**
   * Discovers available services.
   *
   * @param input - Service discovery criteria.
   * @returns A list of matching services.
   */
  discoverServices(input: ListServiceInput): Promise<ListServiceResult[]>;

  /**
   * Discovers available tools.
   *
   * @param input - Tool discovery criteria.
   * @returns A list of matching tools.
   */
  discoverTools(input: ListToolInput): Promise<ListToolResult[]>;

  /**
   * Retrieves a service by identifier.
   *
   * @param id - Unique service identifier.
   * @returns The matching service definition.
   * @throws Error if the service cannot be found.
   */
  getService(id: string): Promise<GetServiceResult>;

  /**
   * Retrieves a tool by identifier.
   *
   * @param input - Tool lookup information.
   * @returns The matching tool definition.
   * @throws Error if the tool cannot be found.
   */
  getTool(input: GetToolInput): Promise<GetToolResult>;

  /**
   * Retrieves generated documentation for a tool.
   *
   * @param input - Tool lookup information.
   * @returns Tool documentation as markdown.
   * @throws Error if the tool cannot be found.
   */
  getToolDocs(input: GetToolInput): Promise<string>;

  /**
   * Invokes a tool.
   *
   * @param input - Tool invocation request.
   * @returns The tool execution result.
   * @throws Error if invocation fails.
   */
  invokeTool(input: InvokeInput): Promise<unknown>;

  /**
   * Updates the current execution state.
   *
   * @param eid - Execution identifier.
   * @param data - New execution state.
   */
  setState(eid: number, data: ExecutionState): void;

  /**
   * Reports an execution error.
   *
   * @param eid - Execution identifier.
   * @param data - Error message.
   */
  setError(eid: number, data: string): void;

  /**
   * Emits stdout data for an execution.
   *
   * @param eid - Execution identifier.
   * @param data - Output bytes written to stdout.
   */
  emitStdout(eid: number, data: Buffer): void;

  /**
   * Emits stderr data for an execution.
   *
   * @param eid - Execution identifier.
   * @param data - Output bytes written to stderr.
   */
  emitStderr(eid: number, data: Buffer): void;

  /**
   * Emits structured execution output.
   *
   * @param eid - Execution identifier.
   * @param data - Output payload.
   */
  emitOutput(eid: number, data: Record<string, unknown>): void;
}

/**
 * Context provided when initializing an environment module.
 */
export interface EnvironmentSetupContext extends ModuleSetupContext {
  bindings: EnvironmentBindings;
}

/**
 * Options that control execution behavior.
 */
export interface ExecutionOptions {
  timeoutMs: number;
}

/**
 * Input used to execute code within an environment.
 */
export interface ExecutionInput {
  eid: number;
  code: string;
  options?: ExecutionOptions;
}

/**
 * Terminal execution states returned when an execution completes.
 */
export const EXECUTION_EXIT_STATES = [
  "failed",
  "success",
  "timeout",
  "canceled",
] as const;

/**
 * Represents the final state of an execution.
 */
export type ExecutionExitState = (typeof EXECUTION_EXIT_STATES)[number];

/**
 * Input used to generate documentation for a tool.
 */
export interface ToolDocsInput {
  serviceId: string;
  toolId: string;
  description: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
}

/**
 * Environment module responsible for executing code and interacting
 * with environment bindings.
 */
export interface EnvironmentModule extends Module {
  /**
   * Initializes the environment module.
   *
   * @param context - Environment setup context.
   * @returns A promise that resolves when initialization completes.
   * @throws Error if initialization fails.
   */
  setup(context: EnvironmentSetupContext): Promise<void>;

  /**
   * Executes code within the environment.
   *
   * @param input - Execution request.
   * @returns The final execution state.
   * @throws Error if execution cannot be started or completed.
   */
  execute(input: ExecutionInput): Promise<ExecutionExitState>;

  /**
   * Terminates a running execution.
   *
   * @param eid - Execution identifier.
   * @returns A promise that resolves when termination completes.
   * @throws Error if the execution cannot be terminated.
   */
  kill(eid: number): Promise<void>;

  /**
   * Generates documentation for the environment.
   *
   * @returns Generated documentation content.
   */
  generateDocs(): Promise<string>;

  /**
   * Generates documentation for a tool.
   *
   * @param input - Tool metadata and schema information.
   * @returns Generated tool documentation.
   */
  generateToolDocs(input: ToolDocsInput): Promise<string>;
}

// Adapter Modules

/**
 * Persisted adapter-specific state for a tool.
 */
export type ToolState = Omit<
  ToolDefinition,
  "id" | "name" | "description" | "inputSchema" | "outputSchema"
>;

/**
 * Persisted state for a hydrated service.
 */
export interface ServiceState extends Omit<
  ServiceDefinition,
  "name" | "description" | "configSchema" | "secretsSchema" | "tools"
> {
  id: string;
  tools: Record<string, ToolState>;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
}

/**
 * Adapter module responsible for managing services and tool execution.
 */
export interface AdapterModule extends Module {
  /**
   * Generates a service definition from adapter-specific input.
   *
   * @param input - Adapter definition source.
   * @returns The generated service definition.
   * @throws Error if definition generation fails.
   */
  generateDefinition(input: string): Promise<ServiceDefinition>;

  /**
   * Loads a service into the adapter.
   *
   * @param state - Persisted service state.
   * @returns A promise that resolves when hydration completes.
   * @throws Error if hydration fails.
   */
  hydrateService(state: ServiceState): Promise<void>;

  /**
   * Unloads a service from the adapter.
   *
   * @param id - Service identifier.
   * @returns A promise that resolves when dehydration completes.
   * @throws Error if dehydration fails.
   */
  dehydrateService(id: string): Promise<void>;

  /**
   * Invokes a tool exposed by the adapter.
   *
   * @param input - Tool invocation request.
   * @returns The tool execution result.
   * @throws Error if invocation fails.
   */
  invoke(input: InvokeInput): Promise<unknown>;
}
