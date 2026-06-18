---
"@cyrnel/openapi": patch
---

Fix workspace exports to point to compiled output and add tsc-alias to build

- Changed `exports` from `./src/index.ts` (TypeScript source) to
  `./dist/src/index.js` (compiled JS) so consumers resolve the built output.
- Fixed `main`/`types` paths to match the actual `dist/src/` layout
  (rootDir is `"."`).
- Added `tsc-alias` to post-process relative imports with `.js` extensions.
