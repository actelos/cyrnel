---
"@cyrnel/mcp": minor
---

Add direct install/update MCP tools alongside registry-only semantic changes

- **module.ts**: `install_module` and `update_module` updated to registry-only
  semantics. New `add_module` (direct .tar.zst install) and `patch_module`
  (direct update) tools added.
- **service.ts**: `create_service` changed to registry-only with optional
  `adapter`/`service_id` overrides; `update_service` updated to registry-only
  semantics. New `add_service` (direct install) and `patch_service` (direct
  update) tools added.
