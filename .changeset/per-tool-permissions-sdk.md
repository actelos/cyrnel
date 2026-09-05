---
"@cyrnel/sdk": minor
---

Add `suspend` and `resume` methods to `EnvironmentModule` interface for per-tool approval workflow, and add `processId` to `ExecutionInput` for process tracking.

**Changes:**
- Add `suspend(eid: number): Promise<void>` and `resume(eid: number, remainingMs?: number): Promise<void>` to `EnvironmentModule` interface
- Add optional `processId?: number` to `ExecutionInput` interface for process tracking during tool invocations
