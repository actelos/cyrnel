---
"@cyrnel/sdk": minor
---

Add per-tool permissions with allow/block/ask and suspended execution state

- Add EXECUTION_STATES `suspended` and corresponding PROCESS_STATES handling for approval gating
- Tool policies and approval requests introduce `allow | block | ask` with default `ask`, centralized gate in ModuleService.invoke, and suspend/resume with expiry and retention sweeps
- Related OpenAPI and SDK type updates for policy and pendingApprovalIds
