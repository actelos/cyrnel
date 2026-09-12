import http from "node:http";
import https from "node:https";
import type {
  AuthScheme,
  ConfigProvider,
  CredentialProvider,
  ResolvedCredential,
  SecurityRequirements,
} from "@cyrnel/sdk";

export interface RequestResult {
  status: string;
  body?: unknown;
}

/**
 * Reads an optional configuration key through the scope-bound provider.
 * Declared-but-unset keys throw `ProviderKeyNotConfigured` (the provider never
 * returns `undefined`), which is treated here as "not configured".
 */
export async function readOptionalConfig(
  provider: ConfigProvider<Record<string, unknown>>,
  key: string,
): Promise<unknown> {
  try {
    return await provider.get(key);
  } catch (err) {
    if (err instanceof Error && err.name === "ProviderKeyNotConfigured") {
      return undefined;
    }
    throw err;
  }
}

export async function resolveServerUrl(
  servers: Array<{
    url: string;
    variables?: Record<
      string,
      { default: string; enum?: string[]; description?: string }
    >;
  }>,
  config: ConfigProvider<Record<string, unknown>>,
): Promise<string> {
  const serverUrl = await readOptionalConfig(config, "serverUrl");
  if (typeof serverUrl === "string" && serverUrl.length > 0) {
    return serverUrl;
  }

  const server = servers?.[0];
  if (!server) return "";

  let url = server.url;
  if (server.variables) {
    for (const [name, variable] of Object.entries(server.variables)) {
      const configKey = `serverVar_${name}`;
      const configured = await readOptionalConfig(config, configKey);
      const value =
        (typeof configured === "string" ? configured : undefined) ??
        variable.default;
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

export interface AuthPlacements {
  headers: Record<string, string>;
  query: Record<string, string>;
  cookies: Record<string, string>;
}

function assertOAuthScopes(
  schemeName: string,
  credential: ResolvedCredential,
  required: readonly string[],
): void {
  if (credential.type !== "oauth2") {
    throw new Error(
      `Credential for scheme '${schemeName}' resolved to '${credential.type}' credentials, expected an OAuth2 token.`,
    );
  }
  const granted = new Set(credential.scopes ?? []);
  const missing = required.filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    throw new Error(
      `Credential for scheme '${schemeName}' lacks required scopes: ${missing.join(", ")}.`,
    );
  }
}

function applyCredential(
  schemeName: string,
  scheme: AuthScheme,
  credential: ResolvedCredential,
  placements: AuthPlacements,
): void {
  switch (scheme.type) {
    case "apiKey":
      if (credential.type !== "apiKey") {
        throw new Error(
          `Credential for scheme '${schemeName}' resolved to '${credential.type}' credentials, expected an API key.`,
        );
      }
      {
        const value =
          scheme.prefix !== undefined && scheme.prefix.length > 0
            ? `${scheme.prefix} ${credential.value}`
            : credential.value;
        if (scheme.in === "header") {
          placements.headers[scheme.paramName] = value;
        } else if (scheme.in === "query") {
          placements.query[scheme.paramName] = value;
        } else {
          placements.cookies[scheme.paramName] = value;
        }
      }
      return;
    case "basic":
      if (credential.type !== "basic") {
        throw new Error(
          `Credential for scheme '${schemeName}' resolved to '${credential.type}' credentials, expected a username and password.`,
        );
      }
      placements.headers.Authorization = `Basic ${Buffer.from(
        `${credential.username}:${credential.password}`,
      ).toString("base64")}`;
      return;
    case "http":
      if (scheme.scheme !== "bearer") {
        throw new Error(
          `Auth scheme '${schemeName}' uses unsupported HTTP auth scheme '${scheme.scheme}'.`,
        );
      }
      if (credential.type !== "bearer") {
        throw new Error(
          `Credential for scheme '${schemeName}' resolved to '${credential.type}' credentials, expected a bearer token.`,
        );
      }
      placements.headers.Authorization = `Bearer ${credential.token}`;
      return;
    case "oauth2":
      if (credential.type !== "oauth2") {
        throw new Error(
          `Credential for scheme '${schemeName}' resolved to '${credential.type}' credentials, expected an OAuth2 token.`,
        );
      }
      {
        const prefix = scheme.tokenPlacement.prefix;
        placements.headers[scheme.tokenPlacement.paramName] =
          prefix !== undefined && prefix.length > 0
            ? `${prefix} ${credential.accessToken}`
            : credential.accessToken;
      }
      return;
  }
}

/**
 * Resolves auth placements for a tool invocation through the host
 * CredentialProvider. Security requirement groups are tried in order (OR);
 * every scheme in a group must resolve (AND). The FIRST satisfiable group in
 * declaration order is selected (deterministic). Fails closed: when no group
 * can be satisfied the last resolution error is thrown — there is no fallback
 * to secrets or any other credential source.
 *
 * OAuth2 scope enforcement: when a requirement lists scopes for an oauth2
 * scheme, the resolved credential must grant every required scope, otherwise
 * the group is unsatisfiable and the next group is tried.
 */
export async function resolveAuthPlacements(
  authSchemes: Readonly<Record<string, AuthScheme>>,
  security: SecurityRequirements | undefined,
  provider: CredentialProvider,
): Promise<AuthPlacements> {
  if (!security || security.length === 0) {
    return { headers: {}, query: {}, cookies: {} };
  }

  let lastError: unknown = null;
  for (const requirement of security) {
    const placements: AuthPlacements = { headers: {}, query: {}, cookies: {} };
    try {
      for (const [schemeName, requiredScopes] of Object.entries(requirement)) {
        const scheme = authSchemes[schemeName];
        if (scheme === undefined) {
          throw new Error(
            `No auth scheme '${schemeName}' declared by the service.`,
          );
        }
        const required = Array.isArray(requiredScopes) ? requiredScopes : [];
        if (required.length > 0 && scheme.type !== "oauth2") {
          throw new Error(
            `Scheme '${schemeName}' requires scopes but is '${scheme.type}', which has no scope concept.`,
          );
        }
        const credential = await provider.getCredential(schemeName);
        if (scheme.type === "oauth2" && required.length > 0) {
          assertOAuthScopes(schemeName, credential, required);
        }
        applyCredential(schemeName, scheme, credential, placements);
      }
      return placements;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("No security requirement could be satisfied for this tool.");
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
