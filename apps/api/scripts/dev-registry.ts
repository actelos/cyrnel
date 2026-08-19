import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { create } from "tar";

const HOST = "127.0.0.1";
const PORT = 9372;
const BASE_URL = `http://${HOST}:${PORT}`;

const AUTH_MODE = (
  process.env.CYRNEL_DEV_REGISTRY_AUTH_MODE ?? "none"
).toLowerCase();
const DRIFT_AUTH = process.env.CYRNEL_DEV_REGISTRY_DRIFT_AUTH === "1";
const API_KEY = process.env.CYRNEL_DEV_REGISTRY_API_KEY ?? "dev-registry-key";
const BEARER_TOKEN =
  process.env.CYRNEL_DEV_REGISTRY_TOKEN ?? "dev-registry-token";
const CLIENT_ID = process.env.CYRNEL_DEV_REGISTRY_CLIENT_ID ?? "dev-client";
const CLIENT_SECRET =
  process.env.CYRNEL_DEV_REGISTRY_CLIENT_SECRET ?? "dev-secret";
const TOKEN_EXPIRES_IN = Number(
  process.env.CYRNEL_DEV_REGISTRY_TOKEN_EXPIRES_IN ?? 3600,
);
const SCOPES = ["definitions:read", "modules:read"];

function advertisedAuth():
  | { type: "apiKey"; name: string }
  | {
      type: "oauth2";
      grantType: "client_credentials";
      tokenEndpoint: string;
      scopes: string[];
    }
  | undefined {
  if (AUTH_MODE === "apikey") {
    return {
      type: "apiKey",
      name: DRIFT_AUTH ? "X-Dev-Registry-Key-Drift" : "X-Dev-Registry-Key",
    };
  }
  if (AUTH_MODE === "oauth2") {
    return {
      type: "oauth2",
      grantType: "client_credentials",
      tokenEndpoint: `${BASE_URL}${DRIFT_AUTH ? "/oauth/drift-token" : "/oauth/token"}`,
      scopes: SCOPES,
    };
  }
  return undefined;
}

function isAuthorized(
  headers: import("node:http").IncomingHttpHeaders,
): boolean {
  if (AUTH_MODE === "apikey") {
    return headers["x-dev-registry-key"] === API_KEY;
  }
  if (AUTH_MODE === "oauth2") {
    return headers.authorization === `Bearer ${BEARER_TOKEN}`;
  }
  return true;
}

function handleTokenRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): void {
  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString("utf8");
  });
  req.on("end", () => {
    const params = new URLSearchParams(body);
    if (
      params.get("grant_type") !== "client_credentials" ||
      params.get("client_id") !== CLIENT_ID ||
      params.get("client_secret") !== CLIENT_SECRET
    ) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_client" }));
      return;
    }
    json(res, {
      access_token: BEARER_TOKEN,
      token_type: "Bearer",
      expires_in: TOKEN_EXPIRES_IN,
    });
  });
}

function unauthorized(res: import("node:http").ServerResponse): void {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

interface DefinitionEntry {
  id: string;
  name: string;
  description?: string;
  kind: string;
  source: string;
  icon?: RegistryIcon;
}

interface ModuleEntry {
  id: string;
  name: string;
  description?: string;
  type: "adapter" | "environment";
  compatibility?: Array<{ identifier: string; version: string }>;
  source: string;
  icon?: RegistryIcon;
}

const ICON_DIR = path.join(os.homedir(), ".cache/cyrnel-dev-registry-icons");

function getIconData(id: string): { data: Buffer; hash: string } | null {
  try {
    const iconPath = path.join(ICON_DIR, `${id}.png`);
    const data = fs.readFileSync(iconPath);
    return { data, hash: createHash("sha256").update(data).digest("hex") };
  } catch {
    return null;
  }
}

function makeIconHash(id: string): string | undefined {
  const icon = getIconData(id);
  return icon?.hash;
}

const DEFINITIONS: DefinitionEntry[] = [
  ["github", "GitHub", "GitHub issues, PRs and repository tooling"],
  ["weather", "Weather", "Open-meteo forecasts and current conditions"],
  ["calendar", "Calendar", "Meeting scheduling and availability"],
  ["mail", "Mail", "Send and read email via SMTP/IMAP"],
  ["search", "Search", "Web search across multiple engines"],
  ["translate", "Translate", "Machine translation between languages"],
  ["maps", "Maps", "Geocoding, directions and points of interest"],
  ["billing", "Billing", "Invoices, payments and subscription state"],
  ["crm", "CRM", "Contacts, deals and pipeline management"],
  ["analytics", "Analytics", "Site traffic and conversion reporting"],
  ["storage", "Storage", "Object storage buckets and signed URLs"],
  ["queue", "Queue", "Message queues and job dispatch"],
  ["auth", "Auth", "User authentication and session management"],
  ["sms", "SMS", "Programmatic SMS delivery"],
  ["monitor", "Monitor", "Uptime checks and incident alerts"],
].map(([id, name, description]) => ({
  id: id as string,
  name: name as string,
  description: description as string,
  kind: "openapi@3.0",
  source: `/definitions/${id}`,
  icon: makeIconHash(id),
}));

const OPENAPI_COMPAT = [{ identifier: "openapi", version: ">=3.0 <4.0" }];

const ADAPTER_COMPATIBILITY: Record<
  string,
  Array<{ identifier: string; version: string }>
> = {
  github: OPENAPI_COMPAT,
  "open-meteo": OPENAPI_COMPAT,
  ical: [{ identifier: "openapi", version: ">=3.1 <4.0" }],
  "smtp-imap": OPENAPI_COMPAT,
  "web-search": OPENAPI_COMPAT,
  deepl: OPENAPI_COMPAT,
  geo: OPENAPI_COMPAT,
  stripe: OPENAPI_COMPAT,
  salesforce: OPENAPI_COMPAT,
  ga4: OPENAPI_COMPAT,
  s3: OPENAPI_COMPAT,
  amqp: [{ identifier: "asyncapi", version: ">=2.0 <3.0" }],
  oidc: OPENAPI_COMPAT,
  twilio: OPENAPI_COMPAT,
  pingdom: OPENAPI_COMPAT,
};

const MODULES: ModuleEntry[] = [
  ["hello-env", "Hello Env", "Echoes input back as output", "adapter"],
  ["ts-env", "TS Env", "TypeScript-only execution sandbox", "adapter"],
  ["py-env", "Py Env", "Python 3 execution sandbox", "environment"],
  ["node-env", "Node Env", "Node.js runtime for adapters", "adapter"],
  ["bash-env", "Bash Env", "Bash script execution sandbox", "environment"],
  ["ruby-env", "Ruby Env", "Ruby execution sandbox", "environment"],
  ["go-env", "Go Env", "Go execution sandbox", "environment"],
  ["http-env", "HTTP Env", "Make outbound HTTP requests", "adapter"],
  ["db-env", "DB Env", "SQLite and Postgres query access", "environment"],
  ["crypto-env", "Crypto Env", "Hashing and signing utilities", "adapter"],
  ["json-env", "JSON Env", "JSON transformation helpers", "adapter"],
  ["regex-env", "Regex Env", "Regular expression helpers", "adapter"],
  ["time-env", "Time Env", "Date and timezone utilities", "adapter"],
  ["github", "GitHub", "GitHub issues, PRs and repository tooling", "adapter"],
  ["open-meteo", "Open-Meteo", "Weather forecasts", "adapter"],
  ["ical", "ICal", "Calendar events and availability", "adapter"],
  ["smtp-imap", "SMTP/IMAP", "Email transport and inbox access", "adapter"],
  ["web-search", "Web Search", "Multi-engine web search", "adapter"],
  ["deepl", "DeepL", "Machine translation", "adapter"],
  ["geo", "Geo", "Geocoding and points of interest", "adapter"],
  ["stripe", "Stripe", "Payments and subscription state", "adapter"],
  ["salesforce", "Salesforce", "CRM records and pipelines", "adapter"],
  ["ga4", "GA4", "Analytics traffic and conversions", "adapter"],
  ["s3", "S3", "Object storage buckets and signed URLs", "adapter"],
  ["amqp", "AMQP", "Message queues and job dispatch", "adapter"],
  ["oidc", "OIDC", "Authentication and sessions", "adapter"],
  ["twilio", "Twilio", "SMS delivery", "adapter"],
  ["pingdom", "Pingdom", "Uptime checks and alerts", "adapter"],
].map(([id, name, description, type]) => {
  const iconHash = makeIconHash(id);
  return {
    id: id as string,
    name: name as string,
    description: description as string,
    type: type as "adapter" | "environment",
    source: `/modules/${id}`,
    compatibility: ADAPTER_COMPATIBILITY[id],
    icon: iconHash
      ? { url: `${BASE_URL}/modules/${id}/icon`, hash: iconHash }
      : undefined,
  };
});

interface FixtureArchive {
  id: string;
  bytes: Buffer;
  hash: string;
}

async function buildFixtureArchive(
  module: ModuleEntry,
): Promise<FixtureArchive> {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "cyrnel-dev-registry-"),
  );
  try {
    await fs.writeFile(
      path.join(tmpDir, "module.json"),
      JSON.stringify({
        id: module.id,
        name: module.name,
        version: "1.0.0",
        description: module.description,
        type: module.type,
        main: "main.js",
        engines: { cyrnel: "^3.0.0" },
        ...(module.compatibility
          ? { compatibility: module.compatibility }
          : {}),
      }),
    );
    await fs.writeFile(
      path.join(tmpDir, "main.js"),
      module.type === "adapter"
        ? ADAPTER_MODULE_SOURCE
        : ENVIRONMENT_MODULE_SOURCE,
    );

    const stream = create({ cwd: tmpDir, gzip: false }, [
      "module.json",
      "main.js",
    ]);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    const tarBytes = Buffer.concat(chunks);
    const bytes = zstdCompressSync(tarBytes);
    return { id: module.id, bytes, hash: sha256(bytes) };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

const ADAPTER_MODULE_SOURCE = `import openapi from "@cyrnel/openapi";

export default {
  configSchema: openapi.configSchema,
  secretsSchema: openapi.secretsSchema,
  instantiate: openapi.instantiate,
};
`;

const ENVIRONMENT_MODULE_SOURCE = `export default {
  configSchema: { type: "object", properties: {} },
  secretsSchema: { type: "null" },
  instantiate: () => ({
    async setup() {},
    async teardown() {},
  }),
};
`;

function buildDefinitionDoc(definition: DefinitionEntry): string {
  return JSON.stringify({
    openapi: "3.0.0",
    info: {
      title: definition.name,
      version: "1.0.0",
      description: definition.description,
    },
    servers: [{ url: `https://api.${definition.id}.example.com` }],
    paths: {
      "/ping": {
        get: {
          summary: "Ping the service",
          operationId: "ping",
          responses: {
            "200": { description: "OK" },
          },
        },
      },
    },
  });
}

const DEFINITION_DOCS: Record<string, string> = {};
for (const definition of DEFINITIONS) {
  DEFINITION_DOCS[definition.id] = buildDefinitionDoc(definition);
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function contentHash(content: string): string {
  return sha256(Buffer.from(content, "utf8"));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", BASE_URL);

  if (AUTH_MODE === "oauth2" && url.pathname === "/oauth/token") {
    return handleTokenRequest(req, res);
  }

  if (url.pathname !== "/.well-known/registry.json") {
    if (!isAuthorized(req.headers)) return unauthorized(res);
  }

  if (url.pathname === "/.well-known/registry.json") {
    const auth = advertisedAuth();
    return json(res, {
      id: "cyrnel-dev",
      ...(auth ? { auth } : {}),
      "definitions.v1": "/definitions/v1",
      "modules.v1": "/modules/v1",
    });
  }

  if (url.pathname === "/definitions/v1") {
    return json(
      res,
      paginate("definitions", DEFINITIONS, url.searchParams, {
        filterableFields: ["query", "kind"],
      }),
    );
  }

  if (url.pathname === "/modules/v1") {
    return json(
      res,
      paginate("modules", MODULES, url.searchParams, {
        filterableFields: ["query", "type"],
      }),
    );
  }

  const definition = matchEntry(DEFINITIONS, url.pathname, "/definitions/");
  if (definition) {
    return json(res, {
      latestVersion: "1.0.0",
      versions: {
        "1.0.0": {
          downloadUrl: `${BASE_URL}/definitions/${definition.id}/definition.json`,
          hash: contentHash(DEFINITION_DOCS[definition.id]),
          id: definition.id,
          kind: definition.kind,
          engines: { cyrnel: "^3.0.0" },
        },
      },
    });
  }

  const definitionDocId = url.pathname.match(
    /^\/definitions\/([A-Za-z0-9_-]+)\/definition\.json$/,
  )?.[1];
  if (definitionDocId && DEFINITION_DOCS[definitionDocId]) {
    return json(res, JSON.parse(DEFINITION_DOCS[definitionDocId] as string));
  }

  const module = matchEntry(MODULES, url.pathname, "/modules/");
  if (module) {
    return json(res, {
      latestVersion: "1.0.0",
      versions: {
        "1.0.0": {
          downloadUrl: `${BASE_URL}/modules/${module.id}/archive.tar.zst`,
          hash: ARCHIVES[module.id]?.hash,
          engines: { cyrnel: "^3.0.0" },
        },
      },
    });
  }

  const archiveId = url.pathname.match(
    /^\/modules\/([A-Za-z0-9_-]+)\/archive\.tar\.zst$/,
  )?.[1];
  if (archiveId && ARCHIVES[archiveId]) {
    res.writeHead(200, {
      "content-type": "application/zstd",
      "content-length": ARCHIVES[archiveId].bytes.length,
    });
    res.end(ARCHIVES[archiveId].bytes);
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: `Not found: ${url.pathname}` }));
});

function matchEntry<T extends { id: string }>(
  entries: T[],
  pathname: string,
  prefix: string,
): T | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const id = pathname.slice(prefix.length);
  if (id.length === 0 || id.includes("/")) return undefined;
  return entries.find((entry) => entry.id === id);
}

function json(res: import("node:http").ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

interface PaginateOptions {
  filterableFields: Array<"query" | "type" | "kind">;
}

function paginate(
  capability: "definitions" | "modules",
  items: Array<DefinitionEntry | ModuleEntry>,
  searchParams: URLSearchParams,
  options: PaginateOptions,
): Record<string, unknown> {
  let filtered = items;

  if (options.filterableFields.includes("query") && searchParams.has("query")) {
    const needle = (searchParams.get("query") ?? "").toLowerCase();
    filtered = filtered.filter((entry) =>
      [entry.id, entry.name, entry.description ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }
  if (options.filterableFields.includes("type") && searchParams.has("type")) {
    const type = searchParams.get("type");
    filtered = filtered.filter(
      (entry) => "type" in entry && entry.type === type,
    );
  }
  if (options.filterableFields.includes("kind") && searchParams.has("kind")) {
    const kind = searchParams.get("kind");
    filtered = filtered.filter(
      (entry) => "kind" in entry && entry.kind === kind,
    );
  }

  let offset = 0;
  const rawCursor = searchParams.get("cursor");
  if (rawCursor) {
    const decoded = Number(
      Buffer.from(rawCursor, "base64url").toString("utf8"),
    );
    if (Number.isInteger(decoded) && decoded >= 0) offset = decoded;
  }

  const limit = clampLimit(Number(searchParams.get("limit")));
  const page = filtered.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const nextCursor =
    nextOffset < filtered.length
      ? Buffer.from(String(nextOffset)).toString("base64url")
      : null;

  return { [capability]: page, nextCursor };
}

function clampLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1) return 10;
  return Math.min(value, 200);
}

const ARCHIVES: Record<string, FixtureArchive> = {};
for (const module of MODULES) {
  ARCHIVES[module.id] = await buildFixtureArchive(module);
}

server.listen(PORT, HOST, () => {
  console.log(`[cyrnel-dev-registry] listening on ${BASE_URL}`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
