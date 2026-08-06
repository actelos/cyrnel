---
"@cyrnel/sdk": minor
---

Add shared `logEntrySchema` (zod), `LogEntry`/`LogLevel`/`LogType` types, and `LOG_LEVELS`/`LOG_TYPES` constants describing the normalized Cyrnel log entry contract. The API persists and serves log entries in this shape; the web log viewer parses the same schema.
