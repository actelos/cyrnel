# @cyrnel/sdk

TypeScript types and interfaces for building Cyrnel modules.

## Install

```bash
npm i @cyrnel/sdk
```

## Usage

```ts
import type {
  Module,
  EnvironmentModule,
  AdapterModule,
  ServiceDefinition,
  ServiceRuntime,
  ToolDefinition,
  JSONSchema,
  ModuleSetupContext,
  ModuleExport,
  EnvironmentModuleExport,
  ModuleLogger,
  ConfigProvider,
  SecretsProvider,
  EnvironmentBindings,
  ExecutionInput,
  ExecutionExitState,
  InvokeInput,
  AuthScheme,
  AuthDefinition,
  CredentialProvider,
} from "@cyrnel/sdk";
```

## Module types

- **`Module`**: Base interface with `setup` and `teardown`
- **`EnvironmentModule`**: Sandboxed runtime module with `execute`/`kill`/`generateDocs`/`suspend`/`resume`
- **`AdapterModule`**: Service adapter module with `generateService`/`hydrateService`/`dehydrateService`/`invoke`

## Providers

`setup()` no longer receives config/secrets snapshots. It receives scope-bound providers with single-key `get()` only:

- **`ConfigProvider<Config>`** / **`SecretsProvider<Secrets>`**: `get(key)` resolves the current value on demand. Undeclared keys throw `ProviderKeyNotDeclared`; declared-but-unset keys throw `ProviderKeyNotConfigured`. Reads never return `undefined` (see `ConfiguredValue<T>`).
- **`CredentialProvider`**: Present as `context.credentials` (and `service.credentials`) iff auth schemes are declared. Resolves credentials on-demand via `getCredential(schemeName)`.

```ts
async setup(context: ModuleSetupContext<{ apiUrl: string }, { apiKey: string }>): Promise<void> {
  const apiUrl = await context.config.get("apiUrl");
  const apiKey = await context.secrets.get("apiKey");
}
```

## Workflow types

- **`ServiceDefinition`**: Describes a service and its tools. Extends `AuthDefinition`, so `schemes` and `security` are required (`schemes: {}` / `security: []` mean "none")
- **`ToolDefinition`**: Describes a single tool with input/output schemas. Its `security` field is a three-way override: `undefined` inherits the service default, `[]` is explicitly anonymous, non-empty fully overrides
- **`ServiceRuntime`**: Live service supplied to `hydrateService` — providers instead of snapshots, explicit `schemes`/`security`, optional `credentials`, and no exposed credential IDs
- **`ToolState`**: Persisted adapter-specific state for a tool (`adapterDomain` + `security`)
- **`InvokeInput`**: Input used to invoke a tool (`serviceId`, `toolId`, `parameters`)

## Execution types

- **`ExecutionInput`**: Code execution request (`executionId` and `processId`, both required, plus `code` and optional `envConfig`)
- **`ExecutionExitState`**: Terminal states (`failed` | `success` | `timeout` | `canceled`)
- **`ExecutionState`**: Active states (`queued` | `running`)
- **`EnvironmentBindings`**: Runtime API available to environment modules:
  - `invokeTool` — Call a tool on a service
  - `setState` / `setError` — Lifecycle signals
  - `emitStdout` / `emitStderr` / `emitOutput` — Stream data

`EnvironmentModule.resume(executionId)` only pauses/resumes execution machinery — the host owns timeout accounting, so there is no timeout override parameter.

## Authentication

- **`AuthScheme`**: Discriminated union of `ApiKeyAuthScheme` | `BasicAuthScheme` | `HttpAuthScheme` (bearer only) | `OAuth2AuthScheme` (`authorizationCode` | `clientCredentials` | `deviceCode`; the host always enforces PKCE `S256`, so there is no challenge-method field)
- **`AuthDefinition`**: Shared `{ schemes, security }` declaration used by `ModuleExport.auth` and `ServiceDefinition`
- **`SecurityRequirement`** / **`SecurityRequirements`**: OR-of-AND groups mapping scheme names to scopes. Scope arrays MUST be empty for non-OAuth2 schemes; adapters pick the first satisfiable group in declaration order
- **`CredentialProvider`**: Resolves owner-scoped credentials on-demand via `getCredential(schemeName)`; at most one credential per `(owner, scheme)`, so resolution is unambiguous
- **`ResolvedCredential`**: Fully resolved credential (`apiKey` | `basic` | `bearer` | `oauth2`); the oauth2 variant carries the provider-granted scopes for required-scope enforcement
- **`OAuthClient`**: Shared application registration (`provider` display label plus required `availableScopes`; `[]` = unscoped-only client)

## Module logging

The host owns all logging. A module receives a single `ModuleLogger` through its `setup` context and never constructs a root logger itself. Every entry a module emits is automatically tagged with `type: "module"`, `moduleId`, `moduleType`, and the owning `adapterId`/`environmentId` — these correlation fields are host-managed and cannot be forged or overridden by the module.

```ts
import type {
  ModuleSetupContext,
  ModuleLogger,
} from "@cyrnel/sdk";

async setup(context: ModuleSetupContext<{ redactionPatterns?: string[] }>): Promise<void> {
  const patterns = await context.config.get("redactionPatterns").catch(() => []);
  this.logger = context.logger.redact(patterns).child({ phase: "setup" });
}

this.logger?.info({ event: "request", path }, "Sending request");
```

- `ModuleLogger` exposes six levels: `trace` / `debug` / `info` / `warn` / `error` / `fatal`, each accepting `(payload?, message?)`
- `child(bindings)` scopes the logger. `bindings` is `ModuleLogBindings` (`{ phase?, event? }` only): the host merges only `phase`/`event`, so a module cannot set host-owned correlation metadata
- `redact(patterns)` returns a **new** logger that applies the module's path patterns **additively** on top of a non-disableable host baseline (secrets / tokens / passwords / authorization). Chained `redact()` calls accumulate; non-string or empty patterns are ignored
- `context` is `Readonly`: a module reads but never mutates the logger's bound metadata

## Module exports

- **`ModuleExport`**: Default export contract — `configSchema`, `secretsSchema`, optional `auth` (`AuthDefinition`, must declare at least one scheme when present), `instantiate()`
- **`EnvironmentModuleExport`**: Extends `ModuleExport` with required `executionConfigSchema` declaring accepted runtime configuration

## Constants

- **`MODULE_LOG_LEVELS`**: `["trace", "debug", "info", "warn", "error", "fatal"]`
- **`EXECUTION_STATES`**: `["queued", "running"]`
- **`EXECUTION_EXIT_STATES`**: `["failed", "success", "timeout", "canceled"]`

## Documentation

More details in our [specification](https://actelos.mintlify.app/cyrnel/sdk-spec/5.0.0/overview).
Built with [Cyrnel](https://github.com/actelos/cyrnel).