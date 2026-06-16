---
"@cyrnel/mcp": minor
---

Add sync_service tool and stale filter to list_services

- **sync_service**: new tool that re-generates a service's tools from its
  stored definition content. Used to recover services marked stale after an
  adapter module update.
- **list_services**: added optional `stale` query parameter to filter by
  stale state.
- **patch_service**: fixed broken tool entry (missing body, caused a parse
  error) with a proper definition that PATCHes the service's source URL.
