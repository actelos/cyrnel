---
"@cyrnel/openapi": patch
---

Normalize dotted OpenAPI operationIds to valid TypeScript identifiers

The openapi adapter now sanitizes operationId values by replacing
non-identifier characters with underscores, enabling Google APIs (Gmail,
Sheets) and other specs with dotted operationIds to install correctly.
