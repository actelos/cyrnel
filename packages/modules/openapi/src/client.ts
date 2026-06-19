export interface RequestResult {
  status: string;
  body?: unknown;
}

export function resolveServerUrl(
  servers: Array<{
    url: string;
    variables?: Record<
      string,
      { default: string; enum?: string[]; description?: string }
    >;
  }>,
  config: Record<string, unknown>,
): string {
  if (config.serverUrl && typeof config.serverUrl === "string") {
    return config.serverUrl;
  }

  const server = servers?.[0];
  if (!server) return "";

  let url = server.url;
  if (server.variables) {
    for (const [name, variable] of Object.entries(server.variables)) {
      const configKey = `serverVar_${name}`;
      const value = (config[configKey] as string) ?? variable.default;
      url = url.replace(`{${name}}`, encodeURIComponent(value));
    }
  }

  return url;
}

export function substitutePathParams(
  path: string,
  pathParams?: Record<string, unknown>,
): string {
  if (!pathParams) return path;
  let resolved = path;
  for (const [key, value] of Object.entries(pathParams)) {
    if (value !== undefined && value !== null) {
      resolved = resolved.replace(
        `{${key}}`,
        encodeURIComponent(String(value)),
      );
    }
  }
  return resolved;
}

export function buildQueryString(
  queryParams?: Record<string, unknown>,
): string {
  if (!queryParams) return "";
  const entries = Object.entries(queryParams).filter(
    ([, v]) => v !== undefined && v !== null,
  );
  if (entries.length === 0) return "";

  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, String(item));
      }
    } else {
      params.append(key, String(value));
    }
  }
  return `?${params.toString()}`;
}

export function buildAuthHeaders(
  secrets: Record<string, unknown>,
  securitySchemes: Record<string, unknown> | undefined,
  security?: Array<Record<string, string[]>>,
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (!security?.length || !securitySchemes) return headers;

  // Security requirements use OR semantics across entries, AND within an entry.
  // We try each requirement entry in order; the first one where we can satisfy
  // at least one scheme wins.
  for (const requirement of security) {
    for (const [schemeName] of Object.entries(requirement)) {
      const scheme = securitySchemes[schemeName] as
        | {
            type: string;
            in?: string;
            name?: string;
            scheme?: string;
          }
        | undefined;
      if (!scheme) continue;

      const secretValue = secrets[schemeName];
      if (secretValue === undefined || secretValue === null) continue;

      if (scheme.type === "apiKey" && scheme.in === "header") {
        headers[scheme.name ?? schemeName] = String(secretValue);
      } else if (scheme.type === "http" && scheme.scheme === "bearer") {
        headers.Authorization = `Bearer ${String(secretValue)}`;
      } else if (scheme.type === "http" && scheme.scheme === "basic") {
        const creds = secretValue as Record<string, string>;
        const encoded = Buffer.from(
          `${creds.username ?? ""}:${creds.password ?? ""}`,
        ).toString("base64");
        headers.Authorization = `Basic ${encoded}`;
      } else if (scheme.type === "oauth2" || scheme.type === "openIdConnect") {
        headers.Authorization = `Bearer ${String(secretValue)}`;
      }

      // One matched scheme is enough for this requirement entry
      break;
    }
    // If we added headers from this requirement, stop (OR semantics)
    if (Object.keys(headers).length > 0) break;
  }

  return headers;
}

export interface RequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

export async function makeRequest(
  options: RequestOptions,
): Promise<RequestResult> {
  const { method, url, headers, body, timeoutMs } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const init: RequestInit = {
      method: method.toUpperCase(),
      headers: {
        accept: "application/json",
        ...headers,
      },
      signal: controller.signal,
    };

    if (body !== undefined) {
      init.body = JSON.stringify(body);
      const h = init.headers as Record<string, string>;
      if (!h["content-type"]) {
        h["content-type"] = "application/json";
      }
    }

    const response = await fetch(url, init);
    const status = String(response.status);

    if (status === "204" || status === "205") {
      return { status };
    }

    const text = await response.text();
    if (!text) {
      return { status };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `HTTP ${status}: Non-JSON response body: ${text.slice(0, 200)}`,
      );
    }

    return { status, body: parsed };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
