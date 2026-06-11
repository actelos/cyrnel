import type { z } from "zod";
import { apiUrl } from "@/lib/env";

export const apiBase = apiUrl();

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function buildUrl(
  path: string,
  params?: Record<string, string | undefined>,
): string {
  const base = apiBase.length > 0 ? apiBase : window.location.origin;
  const url = new URL(path, base);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    });
  }
  return url.toString();
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `Request failed: ${response.status}`;
  try {
    const text = await response.text();
    if (text.trim().length === 0) return fallback;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed?.error === "string" && parsed.error.length > 0) {
        return parsed.error;
      }
    } catch {
      // not JSON, fall through to raw text
    }
    return text;
  } catch {
    return fallback;
  }
}

export async function apiFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new ApiError(await readErrorMessage(response), response.status);
  }
  return response;
}

export async function apiFetchJson<T>(
  url: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await apiFetch(url, init);
  const data = await response.json();
  return schema.parse(data);
}

export async function apiFetchText(
  url: string,
  init?: RequestInit,
): Promise<string> {
  const response = await apiFetch(url, init);
  return response.text();
}

export function errorMessageFrom(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}
