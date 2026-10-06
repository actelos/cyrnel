import { ApiError } from "@/lib/api";

export type ErrorSeverity = "info" | "warning" | "error";

export interface UserFacingError {
  title: string;
  description: string;
  severity: ErrorSeverity;
  retryable: boolean;
  status?: number;
  code?: string;
  technicalDetails?: string;
}

interface ErrorInput {
  status?: number;
  code?: string;
  message?: string;
  retryAfter?: number;
}

function titleForStatus(status: number, code?: string): string {
  if (status === 401 || code === "authentication_required")
    return "Authentication required";
  if (status === 403) {
    if (code === "tool_blocked") return "Tool blocked by policy";
    if (code === "approval_required") return "Approval required";
    if (code === "scope_missing") return "Missing OAuth scope";
    return "Access denied";
  }
  if (status === 404) {
    if (code === "service_stale") return "Service is stale";
    if (code === "module_missing") return "Module missing";
    return "Not found";
  }
  if (status === 409) {
    if (code === "credential_missing") return "Credential missing";
    if (code === "credential_expired") return "Credential expired";
    if (code === "service_stale") return "Service is stale";
    if (code === "update_unavailable") return "Update unavailable";
    if (code === "update_constraint_invalid")
      return "Invalid update constraint";
    return "Conflict";
  }
  if (status === 429) return "Rate limited";
  if (code === "registry_unavailable") return "Registry unavailable";
  if (status === 502) return "Bad gateway";
  if (status === 503) return "Service temporarily unavailable";
  if (status === 504) return "Request timed out";
  if (status >= 500) return "Something went wrong";
  if (status === 400) {
    if (code === "update_constraint_invalid")
      return "Invalid update constraint";
    if (code === "credential_missing") return "Credential missing";
    return "Invalid request";
  }
  return "Request failed";
}

function descriptionForStatus(input: ErrorInput, fallback: string): string {
  const { status = 0, code, message, retryAfter } = input;
  if (message && message.trim().length > 0 && message.trim().length < 300) {
    // Prefer backend human-readable message when concise.
    // Long raw exceptions are surfaced via technicalDetails instead.
    if (status === 429 && retryAfter !== undefined) {
      return `${message.trim()} Try again in ${retryAfter}s.`;
    }
    return message.trim();
  }
  switch (status) {
    case 400:
      return fallback || "Check the provided values and try again.";
    case 401:
      return "Configure an API key to access this Cyrnel instance.";
    case 403:
      return fallback || "You do not have permission to perform this action.";
    case 404:
      return fallback || "The requested item no longer exists.";
    case 409:
      return fallback || "The current state prevents this action.";
    case 429:
      return retryAfter !== undefined
        ? `Too many requests. Try again in ${retryAfter}s.`
        : "Too many requests. Please wait and try again.";
    case 502:
      if (code === "registry_unavailable") {
        return "The registry could not be reached. Check the registry URL and try again.";
      }
      return "A gateway error occurred. Try again shortly.";
    case 503:
      return "A dependency is temporarily unavailable. Try again shortly.";
    case 504:
      return "The request timed out. Try again.";
    default:
      return fallback || "An unexpected error occurred. Try again.";
  }
}

export function userFacingError(
  input: ErrorInput,
  fallback = "",
): UserFacingError {
  const status = input.status ?? 0;
  const code = input.code;
  const severity: ErrorSeverity =
    status === 429 || status === 409 || status === 404
      ? "warning"
      : status >= 500 || status === 401 || status === 403 || status === 400
        ? "error"
        : "error";
  // 4xx conflicts/rate-limits surface as warnings at call sites where
  // appropriate; default severity stays error to preserve destructive styling.
  const retryable =
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status >= 500;
  const technical =
    input.message && input.message.trim().length >= 300
      ? input.message.trim()
      : undefined;
  return {
    title: titleForStatus(status, code),
    description: descriptionForStatus(input, fallback),
    severity,
    retryable,
    status: status || undefined,
    code,
    technicalDetails: technical,
  };
}

export function userFacingErrorFrom(
  error: unknown,
  fallback: string,
): UserFacingError {
  if (error instanceof ApiError) {
    return userFacingError(
      {
        status: error.status,
        code: error.code,
        message: error.message,
        retryAfter: error.retryAfter,
      },
      fallback,
    );
  }
  if (error instanceof Error) {
    return userFacingError({ message: error.message }, fallback);
  }
  return userFacingError({}, fallback);
}
