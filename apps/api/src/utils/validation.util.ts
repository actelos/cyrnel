import Ajv, { type ValidateFunction } from "ajv";
import type { ZodType } from "zod";

import { HttpError } from "@/models/error.model";

const ajv = new Ajv({ allErrors: true, strict: false });
const ajvWithDefaults = new Ajv({
  allErrors: true,
  strict: false,
  useDefaults: true,
});

const defaultsCache = new Map<string, ValidateFunction>();
const validatorCache = new Map<string, ValidateFunction>();

function getValidator(
  schema: Record<string, unknown>,
  cache: Map<string, ValidateFunction>,
  instance: Ajv,
): ValidateFunction {
  const key = JSON.stringify(schema);
  const cached = cache.get(key);
  if (cached) return cached;
  const compiled = instance.compile(schema);
  cache.set(key, compiled);
  return compiled;
}

function formatAjvErrors(validate: ValidateFunction): string {
  return (
    validate.errors
      ?.map(({ instancePath, message }) =>
        `${instancePath || "/"} ${message}`.trim(),
      )
      .join("; ") ?? "Schema validation failed."
  );
}

/**
 * Asserts that `value` is a plain JSON-safe object (no functions, class
 * instances, symbols, or Proxies). Throws an HttpError if not.
 *
 * This is used to verify that module-exported config/secrets schemas are
 * pure data and cannot execute code.
 */
export function assertPlainJsonSchema(
  value: unknown,
  label = "Schema",
): asserts value is Record<string, unknown> {
  const seen = new Set<unknown>();
  function check(v: unknown, path: string): void {
    if (
      v === null ||
      typeof v === "boolean" ||
      typeof v === "number" ||
      typeof v === "string"
    )
      return;
    if (Array.isArray(v)) {
      if (seen.has(v))
        throw new HttpError(
          400,
          `${label} at ${path || "/"} contains a circular reference.`,
        );
      seen.add(v);
      for (let i = 0; i < v.length; i++) check(v[i], `${path}/${i}`);
      return;
    }
    if (typeof v === "object") {
      if (seen.has(v))
        throw new HttpError(
          400,
          `${label} at ${path || "/"} contains a circular reference.`,
        );
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        throw new HttpError(
          400,
          `${label} at ${path || "/"} is a class instance or non-plain object.`,
        );
      }
      seen.add(v);
      for (const key of Object.keys(v as Record<string, unknown>)) {
        check((v as Record<string, unknown>)[key], `${path}/${key}`);
      }
      return;
    }
    throw new HttpError(
      400,
      `${label} at ${path} contains a non-JSON value (${typeof v}).`,
    );
  }
  check(value, "");
}

export function parseOrHttpError<T>(
  schema: ZodType<T>,
  value: unknown,
  fallback = "Invalid request.",
  status = 400,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new HttpError(status, result.error.issues[0]?.message ?? fallback);
}

export function validateJsonSchema(
  schema: Record<string, unknown>,
  payload: unknown,
  message = "Schema validation failed.",
): void {
  const validate = getValidator(schema, validatorCache, ajv);
  if (!validate(payload)) {
    throw new HttpError(400, `${message} ${formatAjvErrors(validate)}`.trim());
  }
}

export function applyJsonSchemaDefaults<T extends Record<string, unknown>>(
  schema: Record<string, unknown>,
  payload: T,
  message = "Schema validation failed.",
): T {
  const normalized = JSON.parse(JSON.stringify(payload ?? {})) as T;
  const validate = getValidator(schema, defaultsCache, ajvWithDefaults);
  if (!validate(normalized)) {
    throw new HttpError(400, `${message} ${formatAjvErrors(validate)}`.trim());
  }
  return normalized;
}

/**
 * Normalizes a summary for persistence: trims surrounding whitespace and
 * falls back to an empty string when absent.
 */
export function normalizeSummary(value: string | undefined): string {
  return value?.trim() ?? "";
}
