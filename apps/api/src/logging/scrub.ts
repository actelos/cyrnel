const REDACTED = "***REDACTED***";

const SECRET_KEY_PATTERN =
  /(secret|token|passw|api[_-]?key|authorization|cookie)/i;

const BASE64_KEY_PATTERN = /^[A-Za-z0-9+/]{40,}={0,2}$/;

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

const KEY_VALUE_PATTERN =
  /\b(api[_-]?key|token|secret|password|passwd|authorization|cookie)(\s*[=:]\s*)[^\s,;]+/gi;

const API_KEY_PATTERN = /\bsk-[A-Za-z0-9]{16,}\b/g;

const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{48,}\b/g;

export function scrubString(input: string): string {
  if (BASE64_KEY_PATTERN.test(input)) return REDACTED;

  let output = input
    .replace(BEARER_PATTERN, REDACTED)
    .replace(KEY_VALUE_PATTERN, "$1$2***REDACTED***");

  for (const pattern of [API_KEY_PATTERN, LONG_TOKEN_PATTERN]) {
    output = output.replace(pattern, REDACTED);
  }

  return output;
}

function scrubValue(value: unknown, key?: string): unknown {
  if (key !== undefined && SECRET_KEY_PATTERN.test(key)) return REDACTED;
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item));
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [nestedKey, nested] of Object.entries(value)) {
      output[nestedKey] = scrubValue(nested, nestedKey);
    }
    return output;
  }
  return value;
}

export function scrubLogObject<T extends Record<string, unknown>>(obj: T): T {
  return scrubValue(obj) as T;
}
