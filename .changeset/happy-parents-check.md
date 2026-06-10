---
"@cyrnel/mcp": patch
---

Fix ESM module resolution: add `.js` extensions to all local imports for native Node.js ESM compatibility. Fix logger to only require `pino-pretty` in development mode so published package works without dev dependencies. Add `repository` field for npm provenance.
