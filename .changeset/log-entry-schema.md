---
"@cyrnel/sdk": major
---

**BREAKING** Overhaul the SDK module-logging contract and trim it to the module-facing surface only.

- Remove API-internal exports that did not belong in the published module SDK: `LOG_LEVELS`, `LOG_TYPES`, `LogLevel`, `LogType`, `createLogEntrySchema`, `logEntrySchema`, `LogEntry`, plus `MODULE_TYPES`/`ModuleType` (the API already owns these and infers the module type from the `AdapterModule`/`EnvironmentModule` interfaces).
- Replace the export-only `ModuleLoggerContext` (which leaked host-managed fields such as `moduleId`, `moduleType`, `serviceId`, `adapterId`, `environmentId`, `executionId`, `dispatchId`, `toolId`, `requestId`) with `ModuleLogBindings`, containing only what a module may set: `phase?` and `event?`. `ModuleLogger.child()` now accepts `ModuleLogBindings` only, and the host's `createModuleLogger` merges only `phase`/`event` from child bindings - so a module can no longer forge or override host-owned correlation metadata.
- `ModuleLogger.context` is now `Readonly<C>`. `AdapterSetupContext` is now a plain `ModuleSetupContext` alias (the adapter-vs-environment distinction lives in the `AdapterModule`/`EnvironmentModule` interfaces).
- `ModuleLogger` gains a pino-like `redact(patterns: readonly string[]): ModuleLogger<C>` method so a **module configures reduction for itself**, from its own `configSchema` field (openapi and typescript-ivm now expose `redactionPatterns` in their own config). The host never pushes patterns into the setup context; `redact()` returns a new logger that applies the module's patterns **additively** on top of a non-disableable baseline (secrets/tokens/passwords/authorization). Patterns accumulate across chained `redact()` calls, and non-string or empty-split entries are ignored so a malformed pattern can never redact the whole payload. `ModuleSetupContext` does **not** carry a `redactionPatterns` field.
- Modules receive a single host-owned `ModuleLogger` via `setupContext` and may call `.child()` for scoped phases or `.redact()` for self-managed reduction; they cannot construct root loggers.
- `ModuleLogger` gains an `isLevelEnabled(level: ModuleLogLevel): boolean` guard, and the SDK exposes `ModuleLogLevel` / `MODULE_LOG_LEVELS` for level checks.

The API now defines its own full `ModuleLoggerContext` (host-managed fields) and `logEntrySchema`/`LogEntry`/`LogLevel`/`LogType`, and the web client defines its own `logEntrySchema` locally - neither depends on the published SDK for the API's response format.
