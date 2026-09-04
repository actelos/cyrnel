---
"@cyrnel/sdk": patch
---

Clarify per-tool permissions: `suspended` is host-only ProcessState

- `suspended` remains a host-only `ProcessState` in `@cyrnel/api` (`processes.state`, `pendingApprovalIds`), not an `ExecutionState` for `EnvironmentBindings.setState`; modules never set it (host manages via `ProcessService.suspendProcess`/`notifyApprovalResolved` with per-process lock and timeout re-arm)
- Tool policies and approval requests (`allow|block|ask`, default `ask`, `approval_requests` CAS, `expiresAt`, sweeps) are host concerns; SDK only adds a doc comment to `EXECUTION_STATES`
