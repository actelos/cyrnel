---
"@cyrnel/api": patch
---

Fix `@/` path alias resolution in compiled output

Add `tsc-alias` as a post-build step to rewrite `@/*` path aliases to
relative imports with `.js` extensions, fixing `ERR_MODULE_NOT_FOUND` when
running the built server with `node dist/index.js`.
