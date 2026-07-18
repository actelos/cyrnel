import http from "node:http";
import https from "node:https";

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
    }

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

function httpRequest(
  method: string,
  urlStr: string,
  reqHeaders: Record<string, string> | undefined,
  reqBody: unknown,
  timeoutMs: number,
): Promise<{ status: string; text: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr);
    const httpModule = parsedUrl.protocol === "https:" ? https : http;

    const bodyStr = reqBody !== undefined ? JSON.stringify(reqBody) : undefined;

    const options: http.RequestOptions = {
      method: method.toUpperCase(),
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        accept: "application/json",
        ...reqHeaders,
        ...(bodyStr !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
      timeout: timeoutMs,
    };

    const req = httpModule.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: String(res.statusCode ?? 0), text });
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    if (bodyStr !== undefined) {
      req.write(bodyStr);
    }
    req.end();
  });
}

export async function makeRequest(
  options: RequestOptions,
): Promise<RequestResult> {
  const { method, url, headers, body, timeoutMs } = options;

  const { status, text } = await httpRequest(
    method,
    url,
    headers,
    body,
    timeoutMs,
  );

  if (status === "204" || status === "205") {
    return { status };
  }

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
}
