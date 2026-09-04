/**
 * Represents a JSON schema-like object used to describe
 * configuration, input, and output structures.
 */
export type JSONSchema = Record<string, unknown>;

/**
 * Log severity levels available to module loggers, lowest to highest.
 */
export const MODULE_LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;

export type ModuleLogLevel = (typeof MODULE_LOG_LEVELS)[number];

/**
 * Bindings a module may attach to its log entries via `logger.child(...)`.
 *
 * Everything that identifies or correlates a log (module id, module type,
 * service/adapter/environment id, execution/dispatch/tool/request id) is
 * injected by the host and is intentionally absent here so a module cannot
 * forge or override host-managed correlation metadata.
 */
export interface ModuleLogBindings {
  phase?: string;
  event?: string;
}

export type ModuleLogPayload = Record<string, unknown>;

/**
 * Logger instance injected into every module via {@link ModuleSetupContext}.
 * Modules must not construct root loggers; they receive one host-owned
 * logger and may call `.child()` to add scoped bindings.
 */
export interface ModuleLogger<C extends ModuleLogBindings = ModuleLogBindings> {
  readonly context: Readonly<C>;
  child<Next extends ModuleLogBindings>(bindings: Next): ModuleLogger<C & Next>;
  /**
   * Returns a new logger that applies the given reduction (redaction) path
   * patterns to every payload, in addition to the host-enforced baseline.
   * The module configures reduction for itself from its own configuration;
   * patterns are merged additively and can never disable the host baseline.
   */
  redact(patterns: readonly string[]): ModuleLogger<C>;
  isLevelEnabled(level: ModuleLogLevel): boolean;
  trace(obj: ModuleLogPayload, message?: string): void;
  trace(message: string): void;
  debug(obj: ModuleLogPayload, message?: string): void;
  debug(message: string): void;
  info(obj: ModuleLogPayload, message?: string): void;
  info(message: string): void;
  warn(obj: ModuleLogPayload, message?: string): void;
  warn(message: string): void;
  error(obj: ModuleLogPayload, message?: string): void;
  error(message: string): void;
  fatal(obj: ModuleLogPayload, message?: string): void;
  fatal(message: string): void;
}

/**
 * Setup context delivered to every module's `setup()` method.
 * Modules receive their configuration, secrets, and a host-owned logger.
 */
export interface ModuleSetupContext<
  C extends ModuleLogBindings = ModuleLogBindings,
> {
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
  logger: ModuleLogger<C>;
}

/**
 * Setup context for adapter modules.
 */
export type AdapterSetupContext = ModuleSetupContext;

/**
 * Setup context for environment modules. In addition to the standard
 * module fields, environment modules receive {@link EnvironmentBindings}.
 */
export interface EnvironmentSetupContext extends ModuleSetupContext {
  bindings: EnvironmentBindings;
}

/**
 * Defines a tool exposed by a service.
 */
export interface ToolDefinition {
  id: string;
  name: string;
  summary?: string;
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
  summary?: string;
  description: string;
  configSchema: JSONSchema;
  secretsSchema: JSONSchema;
  tools: ToolDefinition[];
  adapterDomain: Record<string, unknown>;
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
 * Note: `suspended` is a host-only ProcessState (approval gating) and is
 * intentionally not an ExecutionState-modules never set it via
 * EnvironmentBindings.setState; the host manages it via
 * ProcessService.suspendProcess / notifyApprovalResolved.
 */
export const EXECUTION_STATES = ["queued", "running"] as const;

/**
 * Represents an active execution state.
 */
export type ExecutionState = (typeof EXECUTION_STATES)[number];

/**
 * Provides environment-specific bindings used by environment modules
 * to invoke tools and emit execution events.
 */
export interface EnvironmentBindings {
  /**
   * Sets the state of an execution.
   *
   * @param eid - Execution identifier.
   * @param state - The new execution state.
   */
  setState(eid: number, state: ExecutionState): void;

  /**
   * Marks an execution as failed.
   *
   * @param eid - Execution identifier.
   * @param error - The error message.
   */
  setError(eid: number, error: string): void;

  /**
   * Appends data to stdout for an execution.
   *
   * @param eid - Execution identifier.
   * @param data - Data to append.
   */
  emitStdout(eid: number, data: Buffer): void;

  /**
   * Appends data to stderr for an execution.
   *
   * @param eid - Execution identifier.
   * @param data - Data to append.
   */
  emitStderr(eid: number, data: Buffer): void;

  /**
   * Sets the structured output for an execution.
   *
   * @param eid - Execution identifier.
   * @param data - Output data.
   */
  emitOutput(eid: number, data: Record<string, unknown>): void;

  /**
   * Invokes a tool.
   *
   * @param input - Tool invocation request.
   * @returns The tool execution result.
   * @throws Error if invocation fails.
   */
  invokeTool(input: InvokeInput): Promise<unknown>;
}

/**
 * The default export contract for every module.
 *
 * A module's entry file must default-export an object matching this
 * interface. The host extracts the schemas for config/secrets validation
 * and the `instantiate` factory from it.
 *
 * Both `configSchema` and `secretsSchema` must be plain JSON Schema objects.
 */
export interface ModuleExport {
  configSchema: JSONSchema;
  secretsSchema: JSONSchema;
  instantiate(): Module;
}

/**
 * Input used to execute code within an environment.
 */
export interface ExecutionInput {
  eid: number;
  code: string;
  envConfig?: Record<string, unknown>;
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
  summary?: string;
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

/**
 * Persisted adapter-specific state for a tool.
 */
export type ToolState = Omit<
  ToolDefinition,
  "id" | "name" | "summary" | "description" | "inputSchema" | "outputSchema"
>;

/**
 * Persisted state for a hydrated service.
 */
export interface ServiceState
  extends Omit<
    ServiceDefinition,
    | "name"
    | "summary"
    | "description"
    | "configSchema"
    | "secretsSchema"
    | "tools"
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
