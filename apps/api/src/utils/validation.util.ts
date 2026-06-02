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
