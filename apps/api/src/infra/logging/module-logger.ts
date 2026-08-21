import type {
  ModuleLogBindings,
  ModuleLogger,
  ModuleLogLevel,
  ModuleLogPayload,
} from "@cyrnel/sdk";
import type pino from "pino";
import type { ModuleType } from "@/models/modules.model";

/**
 * Full logger context bound by the host to a module's logger. This is the
 * API-side counterpart to the SDK's {@link ModuleLogBindings}: it carries the
 * host-managed correlation fields that a module is never allowed to set or
 * override (module id, module type, service/adapter/environment ids, and the
 * various execution/dispatch/tool/request ids). Only `phase` and `event`
 * come from the module, via `logger.child(...)`.
 */
export interface ModuleLoggerContext extends ModuleLogBindings {
  category: "module";
  moduleId: string;
  moduleType: ModuleType;
  moduleName?: string;
  moduleVersion?: string;
  serviceId?: string;
  adapterId?: string;
  environmentId?: string;
  executionId?: number;
  dispatchId?: string;
  toolId?: string;
  requestId?: string;
}

const REDACTED = "***REDACTED***";

const DEFAULT_REDACTION_PATTERNS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.set-cookie",
  "headers.authorization",
  "headers.cookie",
  "headers.set-cookie",
  "**.authorization",
  "**.cookie",
  "**.*secret*",
  "**.*token*",
  "**.*password*",
  "**.*passwd*",
  "**.*apiKey*",
  "**.*api_key*",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializeError(err: Error): Record<string, unknown> {
  const output: Record<string, unknown> = {
    type: err.name,
    message: err.message,
  };
  const code = (err as { code?: unknown }).code;
  if (code !== undefined) output.code = serializeValue(code);
  if (err.stack) output.stack = err.stack;
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined) output.cause = serializeValue(cause);
  return output;
}

function serializeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") {
    return `[Function${value.name ? ` ${value.name}` : ""}]`;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return value.toString();
  if (value instanceof Error) return serializeError(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((item) => serializeValue(item, seen));
  }
  if (value instanceof Map) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return Object.fromEntries(
      Array.from(value.entries(), ([key, item]) => [
        String(key),
        serializeValue(item, seen),
      ]),
    );
  }
  if (value instanceof Set) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return Array.from(value, (item) => serializeValue(item, seen));
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = serializeValue(nested, seen);
    }
    return output;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function splitPath(path: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inBracket = false;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < path.length; index += 1) {
    const char = path[index];
    if (inBracket) {
      if (quote !== null) {
        if (char === quote && path[index - 1] !== "\\") {
          quote = null;
        } else {
          current += char;
        }
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        continue;
      }
      if (char === "]") {
        if (current.length > 0) segments.push(current);
        current = "";
        inBracket = false;
        continue;
      }
      if (char !== " " && char !== "\t") current += char;
      continue;
    }

    if (char === ".") {
      if (current.length > 0) segments.push(current);
      current = "";
      continue;
    }
    if (char === "[") {
      if (current.length > 0) segments.push(current);
      current = "";
      inBracket = true;
      continue;
    }
    current += char;
  }

  if (current.length > 0) segments.push(current);
  return segments;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function segmentMatches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const regex = new RegExp(
    `^${escapeRegex(pattern).replace(/\\\*/g, ".*")}$`,
    "i",
  );
  return regex.test(value);
}

function pathMatches(
  path: string[],
  pattern: string[],
  pathIndex = 0,
  patternIndex = 0,
): boolean {
  if (patternIndex >= pattern.length) return pathIndex >= path.length;
  const token = pattern[patternIndex];
  if (token === "**") {
    if (patternIndex === pattern.length - 1) return true;
    for (let index = pathIndex; index <= path.length; index += 1) {
      if (pathMatches(path, pattern, index, patternIndex + 1)) return true;
    }
    return false;
  }
  if (pathIndex >= path.length) return false;
  if (!segmentMatches(token, path[pathIndex])) return false;
  return pathMatches(path, pattern, pathIndex + 1, patternIndex + 1);
}

/**
 * Build the redaction ruleset for a logger by merging the host-enforced
 * baseline (secrets/tokens/passwords/authorization - never disableable)
 * with the module's own additive patterns. Patterns are de-duplicated and
 * pre-split into path segments for matching. Non-string entries and patterns
 * that split to an empty segment list are dropped, since an empty pattern
 * would match the root path and redact the entire payload.
 */
function buildRedactionRules(extraPatterns: readonly string[]): string[][] {
  const merged = new Set<string>([
    ...DEFAULT_REDACTION_PATTERNS,
    ...extraPatterns.filter(
      (pattern): pattern is string => typeof pattern === "string",
    ),
  ]);
  return Array.from(merged)
    .map((pattern) => splitPath(pattern))
    .filter((segments) => segments.length > 0);
}

function redactValue(
  value: unknown,
  rules: string[][],
  path: string[] = [],
): unknown {
  for (const rule of rules) {
    if (pathMatches(path, rule)) return REDACTED;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      redactValue(item, rules, [...path, String(index)]),
    );
  }

  if (value !== null && typeof value === "object") {
    if (!isPlainObject(value)) return value;
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = redactValue(nested, rules, [...path, key]);
    }
    return output;
  }

  return value;
}

function normalizePayload(
  payload: ModuleLogPayload,
  rules: string[][],
): Record<string, unknown> {
  const serialized = serializeValue(payload);
  if (
    serialized === null ||
    typeof serialized !== "object" ||
    Array.isArray(serialized)
  ) {
    return { value: serialized };
  }
  return redactValue(serialized, rules) as Record<string, unknown>;
}

function normalizeMessage(
  objOrMsg: ModuleLogPayload | string,
  msg?: string,
): { payload: ModuleLogPayload; message?: string } {
  if (typeof objOrMsg === "string") {
    return { payload: {}, message: objOrMsg };
  }
  return { payload: objOrMsg, message: msg };
}

function createLevelWriter(
  logger: pino.Logger,
  level: ModuleLogLevel,
  context: ModuleLoggerContext,
  rules: string[][],
): ModuleLogger["trace"] {
  return ((objOrMsg: ModuleLogPayload | string, msg?: string) => {
    if (!logger.isLevelEnabled(level)) return;
    const { payload, message } = normalizeMessage(objOrMsg, msg);
    const data = normalizePayload(
      {
        ...payload,
        type: "module",
        ...context,
      },
      rules,
    );
    if (message === undefined) {
      logger[level](data);
      return;
    }
    logger[level](data, message);
  }) as ModuleLogger["trace"];
}

export function createModuleLogger(
  logger: pino.Logger,
  context: ModuleLoggerContext,
): ModuleLogger<ModuleLoggerContext> {
  return createModuleLoggerWithPatterns(logger, context, []);
}

function createModuleLoggerWithPatterns(
  logger: pino.Logger,
  context: ModuleLoggerContext,
  modulePatterns: readonly string[],
): ModuleLogger<ModuleLoggerContext> {
  const baseContext = Object.freeze({ ...context });
  const childLogger = logger.child({ ...context, type: "module" });
  const rules = buildRedactionRules(modulePatterns);

  // Only `phase`/`event` may be supplied by the module; everything else in
  // the context is host-managed and is preserved from `baseContext` so a
  // module cannot forge or override correlation metadata, even via casts.
  const createChild = <Next extends ModuleLogBindings>(
    bindings: Next,
  ): ModuleLogger<ModuleLoggerContext & Next> =>
    createModuleLoggerWithPatterns(
      logger,
      {
        ...baseContext,
        phase: bindings.phase ?? baseContext.phase,
        event: bindings.event ?? baseContext.event,
      },
      modulePatterns,
    ) as ModuleLogger<ModuleLoggerContext & Next>;

  // Modules configure reduction for themselves: `redact()` returns a new
  // logger that applies the given patterns on top of the host-enforced
  // baseline. Patterns accumulate so chained calls keep prior rules.
  const redact = (
    patterns: readonly string[],
  ): ModuleLogger<ModuleLoggerContext> =>
    createModuleLoggerWithPatterns(logger, baseContext, [
      ...modulePatterns,
      ...patterns,
    ]);

  return {
    context: baseContext,
    child: createChild,
    redact,
    isLevelEnabled: (level: ModuleLogLevel) =>
      childLogger.isLevelEnabled(level),
    trace: createLevelWriter(childLogger, "trace", baseContext, rules),
    debug: createLevelWriter(childLogger, "debug", baseContext, rules),
    info: createLevelWriter(childLogger, "info", baseContext, rules),
    warn: createLevelWriter(childLogger, "warn", baseContext, rules),
    error: createLevelWriter(childLogger, "error", baseContext, rules),
    fatal: createLevelWriter(childLogger, "fatal", baseContext, rules),
  };
}
