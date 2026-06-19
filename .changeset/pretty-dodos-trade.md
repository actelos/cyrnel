---
"@cyrnel/sdk": minor
---

Add `stale` to `ListServiceInput`, `ListServiceResult`, `GetServiceResult` and `effectivelyEnabled` to `GetToolResult`

- `ListServiceInput.stale`: Environment modules can now filter by stale status when discovering services.
- `ListServiceResult.stale` and `GetServiceResult.stale`: Service metadata includes the stale flag in list and get responses.
- `GetToolResult.effectivelyEnabled`: Tool metadata includes the effective enabled state (tool enabled AND service enabled), matching `ListToolResult`.
