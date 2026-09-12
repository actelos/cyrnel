/**
 * A JSON Schema-like object for configuration, input, and output structures.
 * An empty object `{}` means any JSON value is valid, not "no keys allowed."
 * To forbid all keys, use `{ type: "object", properties: {},
 * additionalProperties: false }`.
 */
export type JSONSchema = Record<string, unknown>;

/** Log severity levels available to module loggers, lowest to highest. */
export const MODULE_LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;

/** Union of log severity levels available to module loggers. */
export type ModuleLogLevel = (typeof MODULE_LOG_LEVELS)[number];

/**
 * Bindings a module may attach to log entries via `logger.child(...)`.
 * Host-injected correlation fields (module id, service id, execution id, etc.)
 * are intentionally absent to prevent forging or overriding.
 */
export interface ModuleLogBindings {
  phase?: string;
  event?: string;
}

/** Arbitrary key-value data attached to a log entry. */
export type ModuleLogPayload = Record<string, unknown>;

/**
 * Logger injected into every module via {@link ModuleSetupContext}.
 * Modules must not construct root loggers; they receive one host-owned logger
 * and may call `.child()` to add scoped bindings.
 */
export interface ModuleLogger<C extends ModuleLogBindings = ModuleLogBindings> {
  readonly context: Readonly<C>;

  child<Next extends ModuleLogBindings>(bindings: Next): ModuleLogger<C & Next>;

  /**
   * Returns a new logger applying the given redaction path patterns to every
   * payload, additively on top of the host-enforced baseline. Module patterns
   * can never disable the host baseline.
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
 * The value type of a configured provider key.
 * Schema optionality (`foo?: string` ⇒ `Config[K]` includes `undefined`)
 * describes whether the host allows the key to be absent. Provider reads never
 * return `undefined`; a declared-but-unset key throws `ProviderKeyNotConfigured`.
 * A successful read yields the property type with optionality removed; explicit
 * `null` stays `null`; only the "absent value" channel is removed.
 */
export type ConfiguredValue<T> = T extends undefined ? never : T;

/**
 * Host-owned, scope-bound configuration capability.
 * A provider is permanently bound to one owner scope with no identifier
 * selection; `get(key)` cannot target another module or service.
 * Only single-value reads are exposed; no bulk-read operation. The generic
 * default `{}` means "no keys declared," not an open set of unknown keys.
 * The provider is invalid once its owning scope is destroyed and is never
 * resurrected. Successful mutations invalidate the host's cached representation
 * before completion; cross-process cache coherence is a host concern, not
 * guaranteed by the SDK.
 */
export interface ConfigProvider<Config extends object = {}> {
  /**
   * Returns the current configured value for a declared configuration key.
   *
   * Calling with a key not declared in the schema is a TypeScript error and a
   * runtime `ProviderKeyNotDeclared` error. A declared-but-unset key throws
   * `ProviderKeyNotConfigured`, `get()` never returns `undefined` for a
   * missing value (see {@link ConfiguredValue}).
   */
  get<K extends keyof Config>(key: K): Promise<ConfiguredValue<Config[K]>>;
}

/**
 * Host-owned, scope-bound secrets capability.
 * Secret values are resolved and decrypted on demand, never stored in runtime
 * state. Same scope binding and single-value-read constraints as
 * {@link ConfigProvider}; the generic default `{}` means "no keys declared."
 * The provider is invalid once its owning scope is destroyed and is never
 * resurrected.
 */
export interface SecretsProvider<Secrets extends object = {}> {
  /**
   * Returns the decrypted value for a declared secret key.
   *
   * Calling with a key not declared in the schema is a TypeScript error and a
   * runtime `ProviderKeyNotDeclared` error. A declared-but-unconfigured key
   * throws `ProviderKeyNotConfigured`, `get()` never returns `undefined` for
   * a missing value (see {@link ConfiguredValue}).
   */
  get<K extends keyof Secrets>(key: K): Promise<ConfiguredValue<Secrets[K]>>;
}

/** Discriminated union of authentication schemes supported by services and modules. */
export type AuthScheme =
  | ApiKeyAuthScheme
  | BasicAuthScheme
  | HttpAuthScheme
  | OAuth2AuthScheme;

/** API key sent in a header, query parameter, or cookie. */
export interface ApiKeyAuthScheme {
  readonly type: "apiKey";
  readonly in: "header" | "query" | "cookie";
  readonly paramName: string;
  readonly prefix?: string;
}

/** HTTP Basic `username:password` (base64) in the `Authorization` header. */
export interface BasicAuthScheme {
  readonly type: "basic";
}

/**
 * HTTP auth via the `Authorization` header using a static bearer token.
 * Only `"bearer"` is supported. `"digest"` (challenge-response) is a non-goal
 * for v4. The `bearerFormat` is informational only (e.g. "JWT") and not
 * enforced by the host.
 */
export interface HttpAuthScheme {
  readonly type: "http";
  readonly scheme: "bearer";
  /** Informational only (e.g. "JWT"); not enforced by the host. */
  readonly bearerFormat?: string;
}

/** OAuth 2.0 grant types supported by an {@link OAuth2AuthScheme}. */
export type OAuth2GrantType =
  | "authorizationCode"
  | "clientCredentials"
  | "deviceCode";

/**
 * OAuth 2.0 authentication scheme.
 * PKCE challenge method is intentionally absent: the host always enforces
 * `S256` unconditionally (OAuth 2.1), so a field with one legal value carries
 * no information.
 * `clientAuthMethod: "private_key_jwt"` is a host-internal concern:
 * the host generates the client assertion and acquires the token; the private
 * key is never exposed to the module. Modules only ever see the resulting
 * `oauth2` credential.
 */
export interface OAuth2AuthScheme {
  readonly type: "oauth2";
  readonly grantTypes: readonly OAuth2GrantType[];
  /** Required when `"authorizationCode"` ∈ grantTypes. */
  readonly authorizationUrl?: string;
  /** Required when `"deviceCode"` ∈ grantTypes. */
  readonly deviceAuthorizationUrl?: string;
  readonly tokenUrl: string;
  readonly scopes: Readonly<Record<string, string>>;
  readonly clientAuthMethod?:
    | "client_secret_basic"
    | "client_secret_post"
    | "private_key_jwt"
    | "none";
  readonly additionalTokenParams?: Readonly<Record<string, string>>;
  readonly tokenPlacement: {
    readonly in: "header";
    readonly paramName: string;
    readonly prefix?: string;
  };
}

/**
 * Security requirement: scheme name to required scopes for that scheme.
 * Scope semantics apply only to OAuth2 schemes. For `apiKey`, `basic`, and
 * `http` (bearer) schemes the array MUST be empty; a non-empty array is
 * invalid for those scheme types. An empty scope array means "the scheme is
 * required, with no independent scope concept."
 * `SecurityRequirements` is an OR-of-AND-groups: satisfying one group
 * (`{ OAuth: ["repo:read"] }`) suffices. `Readonly<Record<string, readonly
 * string[]>>` is the hard-cut shape for v4, there is no transitional form.
 */
export type SecurityRequirement = Readonly<Record<string, readonly string[]>>;

/**
 * OR of AND-groups; satisfying any one requirement group suffices.
 * Group resolution by adapters MUST be deterministic: when multiple groups are
 * satisfiable, the first satisfiable group in declaration order is selected.
 */
export type SecurityRequirements = readonly SecurityRequirement[];

/**
 * Shared authentication declaration used by modules (`ModuleExport.auth`)
 * and services (`ServiceDefinition`).
 * Both fields are required: `schemes: {}` means "supports no auth schemes"
 * and `security: []` means "no default security requirements."
 */
export interface AuthDefinition {
  readonly schemes: Readonly<Record<string, AuthScheme>>;
  readonly security: SecurityRequirements;
}

/**
 * A fully resolved credential, narrowed by authentication type.
 * Covers everything an adapter needs to attach a credential to an outbound
 * request. `private_key_jwt` and similar client-assertion credentials are
 * never surfaced here: the host performs assertion generation and token
 * acquisition internally and exposes only the resulting `oauth2` access token.
 */
export type ResolvedCredential =
  | {
      readonly type: "apiKey";
      readonly value: string;
    }
  | {
      readonly type: "basic";
      readonly username: string;
      readonly password: string;
    }
  | {
      readonly type: "bearer";
      readonly token: string;
    }
  | {
      readonly type: "oauth2";
      readonly accessToken: string;
      readonly expiresAt: number;
      /**
       * Scopes granted to this credential by the provider (the credential's
       * `grantedScopes`, never the request). Adapters MUST enforce required
       * scopes against this list: a tool requiring `["repo:read"]` is
       * satisfiable only when every required scope is present. Absent
       * (older hosts) means "unknown" — adapters treat it as empty
       * (fail closed for non-empty requirements).
       */
      readonly scopes?: readonly string[];
    };

/**
 * An OAuth client registration: Cyrnel's application identity with an
 * authorization provider. Global and reusable across any number of
 * owner-scoped credentials. `provider` is a display/grouping label only —
 * it never participates in client resolution and implies no
 * provider-specific OAuth behavior. `availableScopes` is the allow-list
 * for requested scopes (`[]` = unscoped-only client); there is no
 * unconstrained state.
 */
export interface OAuthClient {
  readonly id: string;
  readonly provider: string;
  readonly clientId: string;
  readonly tokenUrl: string;
  readonly authorizationUrl?: string | null;
  readonly clientAuthMethod: string;
  readonly redirectUris: readonly string[];
  readonly availableScopes: readonly string[];
}

/**
 * Host-owned, scope-bound credential capability.
 * Within one provider scope, at most one credential exists for a given
 * security scheme (host-enforced `(owner, scheme)` uniqueness), so
 * `getCredential(schemeName)` is unambiguous. The host resolves
 * owner-scoped credentials on demand; branch selection across
 * multi-branch `SecurityRequirements` remains adapter-owned for v4 and
 * MUST be deterministic (first satisfiable group in declaration order).
 */
export interface CredentialProvider {
  getCredential(schemeName: string): Promise<ResolvedCredential>;
}

/**
 * Setup context delivered to a module's `setup()`.
 * `config`, `secrets`, and `logger` are always present (their provider generic
 * defaults `{}` mean "no keys declared"). `credentials` is present iff the
 * module declares `auth` in its export; it is a compile-time contract, not an
 * optional checked at runtime.
 */
export interface ModuleSetupContext<
  Config extends object = {},
  Secrets extends object = {},
> {
  readonly config: ConfigProvider<Config>;
  readonly secrets: SecretsProvider<Secrets>;
  readonly logger: ModuleLogger;
  readonly credentials?: CredentialProvider;
}

/** Base interface implemented by all Cyrnel modules. */
export interface Module {
  setup(context: ModuleSetupContext): Promise<void>;
  teardown(): Promise<void>;
}

/**
 * Default-export contract for every module.
 * `auth` is optional and present only when the module needs its own
 * authentication. When absent, `ModuleSetupContext.credentials` is absent too.
 * A present `auth` must declare at least one scheme: `auth: { schemes: {} }`
 * has no runtime effect and is rejected by the host. Absence means no auth.
 */
export interface ModuleExport {
  readonly configSchema: JSONSchema;
  readonly secretsSchema: JSONSchema;
  readonly auth?: AuthDefinition;
  instantiate(): Module;
}

/**
 * Tool exposed by a service.
 * Platform invariant: tool invocation parameters are object-shaped —
 * `inputSchema` MUST describe an object schema (never `null`, string, or number).
 */
export interface ToolDefinition<Domain = {}> {
  readonly id: string;
  readonly name: string;
  readonly summary?: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  readonly outputSchema: JSONSchema;
  readonly adapterDomain: Domain;
  /**
   * Tool-specific security requirements.
   *
   * - `undefined` → the tool **inherits** the service's default `security`.
   * - `[]` → explicitly anonymous: the tool requires no authentication,
   *   overriding the service default.
   * - non-empty → full override of the service default for this tool.
   */
  readonly security?: SecurityRequirements;
}

/**
 * Service definition produced by an adapter via `generateService`.
 * `adapterDomain` always exists and is never `undefined`/`null`; an adapter
 * with no metadata uses `{}` as the empty domain.
 */
export interface ServiceDefinition<
  ServiceDomain = {},
  ToolDomain = ServiceDomain,
> extends AuthDefinition {
  readonly name: string;
  readonly summary?: string;
  readonly description: string;
  readonly configSchema: JSONSchema;
  readonly secretsSchema: JSONSchema;
  readonly tools: readonly ToolDefinition<ToolDomain>[];
  readonly adapterDomain: ServiceDomain;
}

/** Adapter-persisted metadata for a tool, including its security requirement. */
export interface ToolState<Domain = {}> {
  readonly adapterDomain: Domain;
  readonly security?: SecurityRequirements;
}

/**
 * Live service representation supplied to an adapter during hydration.
 * Mutable configuration and secrets are represented by scoped providers rather
 * than copied snapshots; credential IDs are intentionally not exposed (the
 * adapter uses `credentials`/`secrets` instead).
 * `schemes` and `security` are declared explicitly (not pulled in via a `Pick`)
 * and are required, `schemes: {}` / `security: []` are the natural "none"
 * values.
 * Invariants:
 * - `schemes` non-empty ⇒ `credentials` capability exists.
 * - `schemes` non-empty ⇏ credentials are configured.
 * - `security` non-empty ⇏ every request can currently authenticate.
 */
export interface ServiceRuntime<
  ServiceDomain = {},
  ToolDomain = {},
  Config extends object = {},
  Secrets extends object = {},
> {
  readonly id: string;
  readonly adapterDomain: ServiceDomain;
  readonly tools: Readonly<Record<string, ToolState<ToolDomain>>>;
  readonly config: ConfigProvider<Config>;
  readonly secrets: SecretsProvider<Secrets>;
  readonly schemes: Readonly<Record<string, AuthScheme>>;
  readonly security: SecurityRequirements;
  readonly credentials?: CredentialProvider;
}

/**
 * Input used to invoke a tool.
 * Platform invariant: `parameters` are object-shaped. The target tool's
 * `inputSchema` MUST describe an object schema (never `null`, string, or
 * number). The generic default `{}` means "no declared parameters."
 */
export interface InvokeInput<Parameters extends object = {}> {
  readonly serviceId: string;
  readonly toolId: string;
  readonly parameters: Parameters;
}

/** Adapter module responsible for managing services and tool execution. */
export interface AdapterModule extends Module {
  generateService(input: string): Promise<ServiceDefinition>;
  hydrateService(service: ServiceRuntime): Promise<void>;
  dehydrateService(serviceId: string): Promise<void>;
  invoke(input: InvokeInput): Promise<unknown>;
}

/**
 * Execution states indicating an execution is still in progress.
 * Note: `suspended` is a host-only `ProcessState` (approval gating) and is
 * intentionally not an `ExecutionState`, modules never set it via
 * `EnvironmentBindings.setState`; the host manages it via
 * `ProcessService.suspendProcess` / `notifyApprovalResolved`.
 */
export const EXECUTION_STATES = ["queued", "running"] as const;

/** An active execution state. */
export type ExecutionState = (typeof EXECUTION_STATES)[number];

/** Terminal execution states returned when an execution completes. */
export const EXECUTION_EXIT_STATES = [
  "failed",
  "success",
  "timeout",
  "canceled",
] as const;

/** Represents the final state of an execution. */
export type ExecutionExitState = (typeof EXECUTION_EXIT_STATES)[number];

/**
 * Input used to execute code within an environment.
 * `executionId` and `processId` are both required: every execution is
 * process-backed for approval and policy tracking. `envConfig` is optional and
 * validated against the environment's `executionConfigSchema` before
 * `execute()`; the SDK prescribes no runtime-config fields.
 * Platform invariant: execution configuration is object-shaped,
 * `executionConfigSchema` MUST describe an object schema.
 */
export interface ExecutionInput<RuntimeConfig extends object = {}> {
  readonly executionId: number;
  readonly processId: number;
  readonly code: string;
  readonly envConfig?: RuntimeConfig;
}

/** Environment-specific bindings used to invoke tools and emit execution events. */
export interface EnvironmentBindings {
  setState(executionId: number, state: ExecutionState): void;

  setError(executionId: number, error: string): void;

  emitStdout(executionId: number, data: Buffer): void;

  emitStderr(executionId: number, data: Buffer): void;

  emitOutput(executionId: number, data: Record<string, unknown>): void;

  invokeTool(input: InvokeInput): Promise<unknown>;
}

/** Setup context for environment modules, adding {@link EnvironmentBindings}. */
export interface EnvironmentSetupContext<
  Config extends object = {},
  Secrets extends object = {},
> extends ModuleSetupContext<Config, Secrets> {
  readonly bindings: EnvironmentBindings;
}

/** Environment module responsible for executing code and generating docs. */
export interface EnvironmentModule extends Module {
  execute(input: ExecutionInput): Promise<ExecutionExitState>;
  kill(executionId: number): Promise<void>;
  suspend(executionId: number): Promise<void>;
  /** Pauses/resumes execution machinery only; the host owns timeout accounting. */
  resume(executionId: number): Promise<void>;
  generateDocs(): Promise<string>;
  generateToolDocs(input: ToolDocsInput): Promise<string>;
}

/**
 * Default-export contract for environment modules.
 * `executionConfigSchema` is required; every environment must declare what
 * runtime configuration it accepts (use `{ type: "object", properties: {},
 * additionalProperties: false }` to accept none).
 */
export interface EnvironmentModuleExport extends ModuleExport {
  readonly executionConfigSchema: JSONSchema;
  instantiate(): EnvironmentModule;
}

/** Input used to generate documentation for a tool. */
export interface ToolDocsInput {
  readonly serviceId: string;
  readonly toolId: string;
  readonly summary?: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  readonly outputSchema: JSONSchema;
}
