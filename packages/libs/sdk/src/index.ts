export type JSONSchema = Record<string, unknown>;

// Base Module

export type ModuleType = "environment" | "adapter";

export interface ModuleManifest {
  id: string;
  name: string;
  description: string;
}

export type ModuleSetupContext = object;

export interface Module {
  readonly type: ModuleType;
  manifest: ModuleManifest;
  setup?(context: ModuleSetupContext): Promise<void>;
  teardown?(): Promise<void>;
}

// Environment Module

export interface DiscoverInput {
  query: string;
  limit?: number;
  enabled?: boolean | null;
}

export interface ServiceDiscoverItem {
  name: string;
  description: string;
  enabled: boolean;
}

export interface ToolDiscoverItem {
  serviceName: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface GetServiceInput {
  serviceName: string;
}

export interface ServiceDetails {
  name: string;
  type: string;
  source: string;
  description: string;
  hash: string;
  enabled: boolean;
  configSchema: JSONSchema;
  secretsSchema: JSONSchema;
}

export interface GetToolInput {
  serviceName: string;
  toolName: string;
}

export interface ToolDetails {
  name: string;
  description: string;
  enabled: boolean;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
}

export interface InvokeInput {
  serviceName: string;
  toolName: string;
  parameters: Record<string, unknown>;
}

export interface EnvironmentBindings {
  discoverServices(input: DiscoverInput): Promise<ServiceDiscoverItem[]>;
  discoverTools(input: DiscoverInput): Promise<ToolDiscoverItem[]>;
  getService(input: GetServiceInput): Promise<ServiceDetails>;
  getTool(input: GetToolInput): Promise<ToolDetails>;
  invokeTool(input: InvokeInput): Promise<unknown>;
  emitStdout(data: Buffer): Promise<void>;
  emitStderr(data: Buffer): Promise<void>;
  emitOutput(data: Record<string, unknown>): Promise<void>;
}

export interface EnvironmentSetupContext extends ModuleSetupContext {
  bindings: EnvironmentBindings;
}

export type ExecutionStatus = "success" | "failed";

export type EnvironmentHydrationPatch = Record<string, unknown>;

export interface EnvironmentExecutionOptions {
  timeoutMs?: number | null;
}

export interface EnvironmentExecutionParams {
  code: string;
  options: EnvironmentExecutionOptions;
}

export interface EnvironmentModule extends Module {
  readonly type: "environment";
  setup(context: EnvironmentSetupContext): Promise<void>;
  hydrate(patch: EnvironmentHydrationPatch): Promise<void>;
  execute(input: EnvironmentExecutionParams): Promise<ExecutionStatus>;
  kill(): Promise<void>;
}

// Adapter Modules

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  metadata: Record<string, unknown>;
}

export interface ServiceDefinition {
  name: string;
  description: string;
  configSchema: JSONSchema;
  secretsSchema: JSONSchema;
  metadata: Record<string, unknown>;
  tools: ToolDefinition[];
}

export type AdapterHydrationPatch = Record<string, unknown>;

export interface AdapterModule extends Module {
  readonly type: "adapter";
  generateDefinition(input: string): Promise<ServiceDefinition>;
  hydrate(patch: AdapterHydrationPatch): Promise<void>;
  invoke(input: InvokeInput): Promise<unknown>;
}
