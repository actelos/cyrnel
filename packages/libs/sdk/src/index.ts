export type JSONSchema = Record<string, unknown>;

// Base Module

export type ModuleSetupContext = object;

export interface Module {
  setup?(context: ModuleSetupContext): Promise<void>;
  teardown?(): Promise<void>;
}

// Environment Module

export interface DiscoverInput {
  query: string;
  limit?: number;
  enabled?: boolean | null;
}

export interface DiscoverServiceItem {
  name: string;
  description: string;
  enabled: boolean;
}

export interface DiscoverToolItem {
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

export type ExecutionState = "idle" | "queued" | "running" | "terminating";

export interface EnvironmentBindings {
  discoverServices(input: DiscoverInput): Promise<DiscoverServiceItem[]>;
  discoverTools(input: DiscoverInput): Promise<DiscoverToolItem[]>;
  getService(input: GetServiceInput): Promise<ServiceDetails>;
  getTool(input: GetToolInput): Promise<ToolDetails>;
  invokeTool(input: InvokeInput): Promise<unknown>;
  setState(eid: number, data: ExecutionState): Promise<void>;
  emitStdout(eid: number, data: Buffer): Promise<void>;
  emitStderr(eid: number, data: Buffer): Promise<void>;
  emitOutput(eid: number, data: Record<string, unknown>): Promise<void>;
}

export interface EnvironmentSetupContext extends ModuleSetupContext {
  bindings: EnvironmentBindings;
}

export type EnvironmentHydrationPatch = Record<string, unknown>;

export interface ExecutionOptions {
  timeoutMs?: number | null;
}

export interface ExecutionParams {
  eid: number;
  code: string;
  options: ExecutionOptions;
}

export type ExecutionExitState = "failed" | "success" | "timeout" | "canceled";

export interface EnvironmentModule extends Module {
  setup(context: EnvironmentSetupContext): Promise<void>;
  hydrate(patch: EnvironmentHydrationPatch): Promise<void>;
  execute(input: ExecutionParams): Promise<ExecutionExitState>;
  kill(eid: number): Promise<void>;
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
  generateDefinition(input: string): Promise<ServiceDefinition>;
  hydrate(patch: AdapterHydrationPatch): Promise<void>;
  invoke(input: InvokeInput): Promise<unknown>;
}
