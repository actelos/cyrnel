---
"@cyrnel/sdk": major
---

Remove discovery and get-bindings types from SDK

Removed the following type exports that were only used by the sandbox
environment's discovery/get-bindings API surface, which is no longer
needed (the model uses MCP tools directly instead):

- `ListServiceInput`, `ListServiceResult`
- `ListToolInput`, `ListToolResult`
- `GetServiceResult`, `GetToolInput`, `GetToolResult`

Removed the corresponding methods from `EnvironmentBindings`:
`discoverServices`, `discoverTools`, `getService`, `getTool`,
`getToolDocs`.
