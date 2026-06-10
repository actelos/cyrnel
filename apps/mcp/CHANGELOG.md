# @cyrnel/mcp

## 1.1.0

### Minor Changes

- 7a5e524: Initial public release of the Cyrnel MCP server.

  - Rewrite MCP server in TypeScript using `fastmcp`
  - Add module management tools: `list_modules`, `get_module`, `create_module`, `update_module`, `delete_module`
  - Add tool management tools: `list_tools`, `execute_tool`
  - Add service management tools: `list_services`
  - Support HTTP (SSE) and stdio transports
  - Add shebang entry point and `cyrnel-mcp` bin
  - Add README with setup and usage instructions
  - Bump all dependencies to latest versions
