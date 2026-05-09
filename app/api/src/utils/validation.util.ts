import Ajv, { type ValidateFunction } from "ajv";
import type { ZodType, z } from "zod";

import { HttpError } from "@/models/error.model";
import type { JSONSchema } from "@/models/manifest.model";

function getValidationMessage(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}

export function parseOrHttpError<T>(
  schema: ZodType<T>,
  value: unknown,
  fallback = "Invalid request.",
  statusCode = 400,
): T {
  const result = schema.safeParse(value);

  if (result.success) {
    return result.data;
  }

  throw new HttpError(statusCode, getValidationMessage(result.error, fallback));
}

export function parseOrError<T>(
  schema: ZodType<T>,
  value: unknown,
  fallback = "Invalid input.",
): T {
  const result = schema.safeParse(value);

  if (result.success) {
    return result.data;
  }

  throw new Error(getValidationMessage(result.error, fallback));
}

const ajv = new Ajv({ allErrors: true, strict: false });
const schemaValidators = new Map<string, ValidateFunction>();

export function validateJsonSchema(
  schema: JSONSchema,
  payload: unknown,
  message = "Schema validation failed.",
): void {
  const key = JSON.stringify(schema);
  const cached = schemaValidators.get(key);
  const validate = cached ?? ajv.compile(schema);

  if (!cached) {
    schemaValidators.set(key, validate);
  }

  if (validate(payload)) {
    return;
  }

  const details =
    validate.errors
      ?.map((error) => {
        const location = error.instancePath || "/";
        return `${location} ${error.message}`.trim();
      })
      .join("; ") ?? "Schema validation failed.";

  throw new HttpError(400, `${message} ${details}`.trim());
}
