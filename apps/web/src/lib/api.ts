import type { z } from "zod";
import { apiUrl } from "@/lib/env";

export const apiBase = apiUrl();

const API_KEY_STORAGE_KEY = "cyrnel.apiKey";

export function getConfiguredApiKey(): string {
  try {
    const stored = window.localStorage.getItem(API_KEY_STORAGE_KEY) ?? "";
    if (stored.trim().length > 0) return stored.trim();
  } catch {
    // localStorage may be unavailable (private mode); fall through to env.
  }
  const envKey = import.meta.env.VITE_CYRNEL_API_KEY as string | undefined;
  return envKey?.trim() ?? "";
}

export function setConfiguredApiKey(key: string): void {
  try {
    if (key.trim().length === 0) {
      window.localStorage.removeItem(API_KEY_STORAGE_KEY);
    } else {
      window.localStorage.setItem(API_KEY_STORAGE_KEY, key.trim());
    }
  } catch {
    // Ignore persistence failures; key simply won't survive reloads.
  }
}

export function hasConfiguredApiKey(): boolean {
  return getConfiguredApiKey().length > 0;
}

export class ApiError extends Error {
  readonly status: number;
  readonly retryAfter?: number;
  readonly code?: string;

  constructor(
    message: string,
    status: number,
    retryAfter?: number,
    code?: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfter = retryAfter;
    this.code = code;
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

async function readErrorBody(response: Response): Promise<{
  message: string;
  code?: string;
  retryAfter?: number;
}> {
  const fallback = `Request failed: ${response.status}`;
  try {
    const text = await response.text();
    if (text.trim().length === 0) return { message: fallback };
    try {
      const parsed = JSON.parse(text) as {
        error?: unknown;
        code?: unknown;
        retryAfter?: unknown;
      };
      if (typeof parsed?.error === "string" && parsed.error.length > 0) {
        return {
          message: parsed.error,
          code:
            typeof parsed.code === "string" && parsed.code.length > 0
              ? parsed.code
              : undefined,
          retryAfter:
            typeof parsed.retryAfter === "number"
              ? parsed.retryAfter
              : undefined,
        };
      }
    } catch {}
    return { message: text };
  } catch {
    return { message: fallback };
  }
}

function withAuthHeader(init?: RequestInit): RequestInit | undefined {
  const apiKey = getConfiguredApiKey();
  if (!apiKey) return init;
  const headers = new Headers(init?.headers);
  // Never overwrite an explicit Authorization header set by the caller.
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  return { ...init, headers };
}

export async function apiFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(url, withAuthHeader(init));
  if (!response.ok) {
    const body = await readErrorBody(response);
    const message = body.message || `Request failed: ${response.status}`;
    throw new ApiError(message, response.status, body.retryAfter, body.code);
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
