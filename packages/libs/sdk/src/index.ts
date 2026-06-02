export type JSONSchema = Record<string, unknown>;

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  adapterDomain: Record<string, unknown>;
}

export interface ServiceDefinition {
  name: string;
  description: string;
  configSchema: JSONSchema;
  secretsSchema: JSONSchema;
  tools: ToolDefinition[];
  adapterDomain: Record<string, unknown>;
}

// Base Module

export type ModuleSetupContext = object;

export interface Module {
  setup(context: ModuleSetupContext): Promise<void>;
  teardown(): Promise<void>;
}

// Environment Module

export interface ListServiceInput {
  query?: string;
  limit?: number;
  enabled?: boolean;
}

export interface ListServiceResult
  extends Omit<
    ServiceDefinition,
    "configSchema" | "secretsSchema" | "tools" | "adapterDomain"
  > {
  id: string;
  enabled: boolean;
}

export interface ListToolInput {
  serviceId?: string;
  query?: string;
  limit?: number;
  enabled?: boolean;
}

export interface ListToolResult
  extends Omit<
    ToolDefinition,
    "inputSchema" | "outputSchema" | "adapterDomain"
  > {
  serviceId: string;
  enabled: boolean;
  effectivelyEnabled: boolean;
}

export interface GetServiceResult
  extends Omit<ServiceDefinition, "tools" | "adapterDomain"> {
  enabled: boolean;
}

export interface GetToolInput {
  serviceId: string;
  toolId: string;
}

export interface GetToolResult
  extends Omit<ToolDefinition, "id" | "adapterDomain"> {
  enabled: boolean;
}

export interface InvokeInput {
  serviceId: string;
  toolId: string;
  parameters: Record<string, unknown>;
}

export const EXECUTION_STATES = ["queued", "running"] as const;

export type ExecutionState = (typeof EXECUTION_STATES)[number];

export interface EnvironmentBindings {
  discoverServices(input: ListServiceInput): Promise<ListServiceResult[]>;
  discoverTools(input: ListToolInput): Promise<ListToolResult[]>;
  getService(id: string): Promise<GetServiceResult>;
  getTool(input: GetToolInput): Promise<GetToolResult>;
  getToolDocs(input: GetToolInput): Promise<string>;
  invokeTool(input: InvokeInput): Promise<unknown>;
  setState(eid: number, data: ExecutionState): void;
  setError(eid: number, data: string): void;
  emitStdout(eid: number, data: Buffer): void;
  emitStderr(eid: number, data: Buffer): void;
  emitOutput(eid: number, data: Record<string, unknown>): void;
}

export interface EnvironmentSetupContext extends ModuleSetupContext {
  bindings: EnvironmentBindings;
}

export interface ExecutionOptions {
  timeoutMs: number;
}

export interface ExecutionInput {
  eid: number;
  code: string;
  options?: ExecutionOptions;
}

export const EXECUTION_EXIT_STATES = [
  "failed",
  "success",
  "timeout",
  "canceled",
] as const;

export type ExecutionExitState = (typeof EXECUTION_EXIT_STATES)[number];

export interface ToolDocsInput {
  serviceId: string;
  toolId: string;
  description: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
}

export interface EnvironmentModule extends Module {
  setup(context: EnvironmentSetupContext): Promise<void>;
  execute(input: ExecutionInput): Promise<ExecutionExitState>;
  kill(eid: number): Promise<void>;
  generateDocs(): Promise<string>;
  generateToolDocs(input: ToolDocsInput): Promise<string>;
}

// Adapter Modules

export type ToolState = Omit<
  ToolDefinition,
  "id" | "name" | "description" | "inputSchema" | "outputSchema"
>;

export interface ServiceState
  extends Omit<
    ServiceDefinition,
    "name" | "description" | "configSchema" | "secretsSchema" | "tools"
  > {
  id: string;
  tools: Record<string, ToolState>;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
}

export interface AdapterModule extends Module {
  generateDefinition(input: string): Promise<ServiceDefinition>;
  hydrateService(state: ServiceState): Promise<void>;
  dehydrateService(id: string): Promise<void>;
  invoke(input: InvokeInput): Promise<unknown>;
}
