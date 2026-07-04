# @cyrnel/sdk

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
