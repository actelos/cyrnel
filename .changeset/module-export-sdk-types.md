---
"@cyrnel/sdk": patch
---

Add ModuleExport interface and restore missing EnvironmentBindings methods

Added `ModuleExport`, the contract for a module's default export
(`{ configSchema, secretsSchema, instantiate }`).

Restored the following lifecycle methods on `EnvironmentBindings` that were
inadvertently dropped when the discovery types were removed:
`setState`, `setError`, `emitStdout`, `emitStderr`, `emitOutput`,
`invokeTool`.
