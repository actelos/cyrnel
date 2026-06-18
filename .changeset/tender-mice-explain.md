---
"@cyrnel/typescript-ivm": patch
---

Fix workspace exports to point to compiled output

Changed `exports` from `./src/index.ts` (TypeScript source) to
`./dist/index.js` (compiled JS) so consumers resolve the built output
instead of the raw `.ts` source.
