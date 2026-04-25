import type { ZodType, z } from "zod";

import { HttpError } from "@/models/error.model";

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
