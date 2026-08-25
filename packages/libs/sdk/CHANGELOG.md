# @cyrnel/sdk

## 4.0.0

### Major Changes

- 2fa938a: **BREAKING** Overhaul the SDK module-logging contract and trim it to the module-facing surface only.

  - Remove API-internal exports that did not belong in the published module SDK: `LOG_LEVELS`, `LOG_TYPES`, `LogLevel`, `LogType`, `createLogEntrySchema`, `logEntrySchema`, `LogEntry`, plus `MODULE_TYPES`/`ModuleType` (the API already owns these and infers the module type from the `AdapterModule`/`EnvironmentModule` interfaces).
  - Replace the export-only `ModuleLoggerContext` (which leaked host-managed fields such as `moduleId`, `moduleType`, `serviceId`, `adapterId`, `environmentId`, `executionId`, `dispatchId`, `toolId`, `requestId`) with `ModuleLogBindings`, containing only what a module may set: `phase?` and `event?`. `ModuleLogger.child()` now accepts `ModuleLogBindings` only, and the host's `createModuleLogger` merges only `phase`/`event` from child bindings - so a module can no longer forge or override host-owned correlation metadata.
  - `ModuleLogger.context` is now `Readonly<C>`. `AdapterSetupContext` is now a plain `ModuleSetupContext` alias (the adapter-vs-environment distinction lives in the `AdapterModule`/`EnvironmentModule` interfaces).
  - `ModuleLogger` gains a pino-like `redact(patterns: readonly string[]): ModuleLogger<C>` method so a **module configures reduction for itself**, from its own `configSchema` field (openapi and typescript-ivm now expose `redactionPatterns` in their own config). The host never pushes patterns into the setup context; `redact()` returns a new logger that applies the module's patterns **additively** on top of a non-disableable baseline (secrets/tokens/passwords/authorization). Patterns accumulate across chained `redact()` calls, and non-string or empty-split entries are ignored so a malformed pattern can never redact the whole payload. `ModuleSetupContext` does **not** carry a `redactionPatterns` field.
  - Modules receive a single host-owned `ModuleLogger` via `setupContext` and may call `.child()` for scoped phases or `.redact()` for self-managed reduction; they cannot construct root loggers.
  - `ModuleLogger` gains an `isLevelEnabled(level: ModuleLogLevel): boolean` guard, and the SDK exposes `ModuleLogLevel` / `MODULE_LOG_LEVELS` for level checks.

  The API now defines its own full `ModuleLoggerContext` (host-managed fields) and `logEntrySchema`/`LogEntry`/`LogLevel`/`LogType`, and the web client defines its own `logEntrySchema` locally - neither depends on the published SDK for the API's response format.

### Minor Changes

- 2fa938a: Add optional `summary` fields to `ServiceDefinition`, `ToolDefinition`, and `ToolDocsInput` for short plain-text descriptions surfaced in lists, search, and agent-visible tool docs.

## 3.0.0

### Major Changes

- 685ee1f: Remove `ExecutionOptions` interface; add `envConfig` to `ExecutionInput`

  ### Breaking changes

  - **Removed** `ExecutionOptions` interface
  - **Changed** `ExecutionInput.options?: ExecutionOptions` → `ExecutionInput.envConfig?: Record<string, unknown>`
  - Environment modules now read per-execution configuration from `input.envConfig` instead of `input.options`

  ### Migration

  Replace `input.options?.timeoutMs` with `input.envConfig?.timeoutMs` in environment module `execute()` implementations.

## 2.0.0

### Major Changes

- 06762ca: Remove discovery and get-bindings types from SDK

  Removed the following type exports that were only used by the sandbox
  environment's discovery/get-bindings API surface, which is no longer
  needed (the model uses MCP tools directly instead):

  - `ListServiceInput`, `ListServiceResult`
  - `ListToolInput`, `ListToolResult`
  - `GetServiceResult`, `GetToolInput`, `GetToolResult`

  Removed the corresponding methods from `EnvironmentBindings`:
  `discoverServices`, `discoverTools`, `getService`, `getTool`,
  `getToolDocs`.

### Patch Changes

- 24b4098: Add ModuleExport interface and restore missing EnvironmentBindings methods

  Added `ModuleExport`, the contract for a module's default export
  (`{ configSchema, secretsSchema, instantiate }`).

  Restored the following lifecycle methods on `EnvironmentBindings` that were
  inadvertently dropped when the discovery types were removed:
  `setState`, `setError`, `emitStdout`, `emitStderr`, `emitOutput`,
  `invokeTool`.

## 1.2.0

### Minor Changes

- 5820828: Add `stale` to `ListServiceInput`, `ListServiceResult`, `GetServiceResult` and `effectivelyEnabled` to `GetToolResult`

  - `ListServiceInput.stale`: Environment modules can now filter by stale status when discovering services.
  - `ListServiceResult.stale` and `GetServiceResult.stale`: Service metadata includes the stale flag in list and get responses.
  - `GetToolResult.effectivelyEnabled`: Tool metadata includes the effective enabled state (tool enabled AND service enabled), matching `ListToolResult`.

### Patch Changes

- 5820828: Add `effectivelyEnabled` to `ListServiceResult`, `GetServiceResult`, and `ListToolResult`

## 1.1.2

### Patch Changes

- 8e57bb6: Exclude source maps from published package, add missing package metadata for npm publishing

## 1.1.1

### Patch Changes

- 0ac3645: remove source maps from build output; add repository field

## 1.1.0

### Minor Changes

- 752be8c: First public release.
