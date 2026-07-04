---
"@cyrnel/sdk": major
---

Remove `ExecutionOptions` interface; add `envConfig` to `ExecutionInput`

### Breaking changes

- **Removed** `ExecutionOptions` interface
- **Changed** `ExecutionInput.options?: ExecutionOptions` → `ExecutionInput.envConfig?: Record<string, unknown>`
- Environment modules now read per-execution configuration from `input.envConfig` instead of `input.options`

### Migration

Replace `input.options?.timeoutMs` with `input.envConfig?.timeoutMs` in environment module `execute()` implementations.
