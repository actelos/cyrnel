export const LOG_SEVERITIES = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;

export type LogSeverity = (typeof LOG_SEVERITIES)[number];

export interface LogQueryFilters {
  query?: string;
  severity?: LogSeverity;
  from?: number;
  to?: number;
  limit: number;
  offset: number;
}

export interface StoredLog {
  id: number;
  timestampMs: number;
  severity: LogSeverity;
  level: number;
  message: string;
  requestMethod: string | null;
  requestPath: string | null;
  statusCode: number | null;
}
