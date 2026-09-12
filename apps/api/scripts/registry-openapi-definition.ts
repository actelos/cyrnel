import { resolve } from "node:path";
import type { OpenAPIObject } from "openapi3-ts/oas30";
import { createGenerator } from "ts-json-schema-generator";

const WIRE_TYPES = [
  "RegistryWellKnownDocument",
  "RegistryCapabilityObject",
  "RegistryDefinitionsWirePage",
  "RegistryModulesWirePage",
  "RegistryEntry",
  "RegistryIcon",
  "VersionedRegistryDescriptor",
  "RegistryVersionEntry",
  "RegistryAuthDeclaration",
  "RegistryTokenRequest",
  "RegistryTokenResponse",
  "RegistryErrorResponse",
] as const;

function toOpenApi30Schema(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(toOpenApi30Schema);
  }
  if (node === null || typeof node !== "object") {
    return node;
  }
  const record = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "$ref" && typeof value === "string") {
      out[key] = value.startsWith("#/definitions/")
        ? value.replace("#/definitions/", "#/components/schemas/")
        : value;
    } else if (key === "const") {
      const existing =
        "enum" in record && Array.isArray(record.enum)
          ? (record.enum as unknown[])
          : [];
      out.enum = [...existing, value];
    } else if (key === "type" && Array.isArray(value)) {
      const rest = (value as unknown[]).filter((type) => type !== "null");
      if (rest.length === 1) {
        out[key] = rest[0];
        if (value.includes("null")) {
          out.nullable = true;
        }
      } else {
        out.anyOf = rest.map((type) => ({ type }));
        if (value.includes("null")) {
          out.nullable = true;
        }
      }
    } else {
      out[key] = toOpenApi30Schema(value);
    }
  }
  return out;
}

function assertOpenApi30Clean(schemas: Record<string, unknown>): void {
  const serialized = JSON.stringify(schemas);
  const leftovers = ["#/definitions/", '"const"'].filter((marker) =>
    serialized.includes(marker),
  );
  const hasTypeArray = /"type":\s*\[/.test(serialized);
  const hasNullType =
    /"type":\s*"null"/.test(serialized) || /"type":"null"/.test(serialized);
  if (leftovers.length > 0 || hasTypeArray || hasNullType) {
    throw new Error(
      `Registry schemas are not OpenAPI 3.0-clean (found ${[...leftovers, hasTypeArray ? "type arrays" : "", hasNullType ? '"type":"null"' : ""].filter(Boolean).join(", ")}); extend toOpenApi30Schema.`,
    );
  }
}

function componentSchemas(): Record<string, unknown> {
  const generator = createGenerator({
    path: resolve(process.cwd(), "src/utils/registry.util.ts"),
    tsconfig: resolve(process.cwd(), "tsconfig.json"),
    type: [...WIRE_TYPES],
    jsDoc: "extended",
    skipTypeCheck: true,
  });
  const merged: Record<string, unknown> = {};
  for (const name of WIRE_TYPES) {
    const schema = generator.createSchema(name) as {
      definitions?: Record<string, unknown>;
    };
    for (const [key, definition] of Object.entries(schema.definitions ?? {})) {
      const existing = merged[key];
      if (
        existing !== undefined &&
        JSON.stringify(existing) !== JSON.stringify(definition)
      ) {
        throw new Error(
          `Conflicting schema definitions generated for '${key}'.`,
        );
      }
      merged[key] = definition;
    }
  }
  const missing = WIRE_TYPES.filter((name) => !(name in merged));
  if (missing.length > 0) {
    throw new Error(
      `Registry schema generation is missing definitions: ${missing.join(", ")}.`,
    );
  }
  const converted = Object.fromEntries(
    Object.entries(merged).map(([name, schema]) => [
      name,
      toOpenApi30Schema(schema),
    ]),
  );
  assertOpenApi30Clean(converted);
  return converted;
}

const ref = (name: (typeof WIRE_TYPES)[number]) => ({
  $ref: `#/components/schemas/${name}`,
});

const errorResponses = (description: string) => ({
  description,
  content: {
    "application/json": { schema: ref("RegistryErrorResponse") },
  },
});

const FIXTURE_URL = "http://127.0.0.1:9372";
const DYNAMIC_URL_NOTE =
  "Reference-fixture path. Real registries advertise their own capability URLs in the well-known document; Cyrnel follows the advertised URL, which must stay on the registry's origin.";

export function generateRegistryOpenApiDoc(): OpenAPIObject {
  const schemas = componentSchemas();
  return {
    openapi: "3.0.0",
    info: {
      title: "Cyrnel Registry API",
      version: "1.0.0",
      description:
        "Contract a registry host implements so Cyrnel can discover capabilities, browse definitions and modules, resolve version descriptors, download artifacts, and exchange OAuth2 tokens. Capability URLs are dynamic and advertised per registry; the paths below mirror the reference fixture (`apps/api/scripts/dev-registry.ts`, served via `pnpm -C apps/api registry:dev`). See the Registry Specification docs for the full operator guide.",
    },
    servers: [
      {
        url: "{baseUrl}",
        description:
          "Registry base URL. Defaults to the local reference fixture.",
        variables: {
          baseUrl: {
            default: FIXTURE_URL,
            description: "Absolute http(s) base URL of the registry.",
          },
        },
      },
    ],
    tags: [
      {
        name: "Discovery",
        description: "Well-known capability advertisement.",
      },
      {
        name: "Capabilities",
        description: "Paginated browse pages for definitions and modules.",
      },
      {
        name: "Descriptors",
        description: "Per-entry version descriptors resolving to artifacts.",
      },
      {
        name: "Artifacts",
        description: "Versioned definition documents and module archives.",
      },
      {
        name: "Authentication",
        description: "OAuth2 token exchange and authorization entry points.",
      },
    ],
    paths: {
      "/.well-known/registry.json": {
        get: {
          tags: ["Discovery"],
          summary: "Discover registry capabilities",
          description:
            "Returns the registry id, the highest-supported `definitions.vN` / `modules.vN` capability URLs (bare string or `{ url, security }` object form), and the optional `auth` declaration. Discovery is public by definition and never attaches auth. Unknown keys are ignored.",
          responses: {
            200: {
              description: "Registry discovery document.",
              content: {
                "application/json": {
                  schema: ref("RegistryWellKnownDocument"),
                },
              },
            },
          },
        },
      },
      "/definitions/v1": {
        get: {
          tags: ["Capabilities"],
          summary: "Browse service definitions",
          description: `${DYNAMIC_URL_NOTE} Query filters are advisory and registry-defined. Cyrnel always sends \`limit\` (default 50).`,
          parameters: [
            {
              name: "query",
              in: "query",
              schema: { type: "string" },
              description:
                "Free-text search forwarded to the registry; matching semantics are registry-defined.",
            },
            {
              name: "kind",
              in: "query",
              schema: { type: "string" },
              description:
                "Definition kind filter (e.g. `openapi@3.0`) forwarded to the registry.",
            },
            {
              name: "cursor",
              in: "query",
              schema: { type: "string" },
              description:
                "Opaque cursor returned as nextCursor by the previous page.",
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 200 },
              description:
                "Maximum entries per page. Cyrnel defaults to 50; registries may clamp to [1, 200].",
            },
          ],
          responses: {
            200: {
              description: "One page of advertised service definitions.",
              content: {
                "application/json": {
                  schema: ref("RegistryDefinitionsWirePage"),
                },
              },
            },
            400: errorResponses("The browse page failed validation."),
            401: errorResponses(
              "A registry credential was required but missing or invalid.",
            ),
          },
        },
      },
      "/modules/v1": {
        get: {
          tags: ["Capabilities"],
          summary: "Browse modules",
          description: `${DYNAMIC_URL_NOTE} Query filters are advisory and registry-defined. Cyrnel always sends \`limit\` (default 50).`,
          parameters: [
            {
              name: "query",
              in: "query",
              schema: { type: "string" },
              description:
                "Free-text search forwarded to the registry; matching semantics are registry-defined.",
            },
            {
              name: "type",
              in: "query",
              schema: { type: "string", enum: ["adapter", "environment"] },
              description: "Module type filter forwarded to the registry.",
            },
            {
              name: "cursor",
              in: "query",
              schema: { type: "string" },
              description:
                "Opaque cursor returned as nextCursor by the previous page.",
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 200 },
              description:
                "Maximum entries per page. Cyrnel defaults to 50; registries may clamp to [1, 200].",
            },
          ],
          responses: {
            200: {
              description: "One page of advertised modules.",
              content: {
                "application/json": {
                  schema: ref("RegistryModulesWirePage"),
                },
              },
            },
            400: errorResponses("The browse page failed validation."),
            401: errorResponses(
              "A registry credential was required but missing or invalid.",
            ),
          },
        },
      },
      "/definitions/{id}": {
        get: {
          tags: ["Descriptors"],
          summary: "Resolve a definition version descriptor",
          description: `${DYNAMIC_URL_NOTE} Entry \`source\` URLs must resolve to the registry's origin. Cyrnel selects \`latestVersion\` by default or the highest version satisfying a semver constraint.`,
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Entry slug from the browse page.",
            },
          ],
          responses: {
            200: {
              description: "Version descriptor for one service definition.",
              content: {
                "application/json": {
                  schema: ref("VersionedRegistryDescriptor"),
                },
              },
            },
            400: errorResponses("The descriptor failed validation."),
            401: errorResponses(
              "A registry credential was required but missing or invalid.",
            ),
            404: errorResponses(
              "No version satisfies the requested constraint.",
            ),
          },
        },
      },
      "/modules/{id}": {
        get: {
          tags: ["Descriptors"],
          summary: "Resolve a module version descriptor",
          description: `${DYNAMIC_URL_NOTE} Entry \`source\` URLs must resolve to the registry's origin. Cyrnel selects \`latestVersion\` by default or the highest version satisfying a semver constraint.`,
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Entry slug from the browse page.",
            },
          ],
          responses: {
            200: {
              description: "Version descriptor for one module.",
              content: {
                "application/json": {
                  schema: ref("VersionedRegistryDescriptor"),
                },
              },
            },
            400: errorResponses("The descriptor failed validation."),
            401: errorResponses(
              "A registry credential was required but missing or invalid.",
            ),
            404: errorResponses(
              "No version satisfies the requested constraint.",
            ),
          },
        },
      },
      "/definitions/{id}/definition.json": {
        get: {
          tags: ["Artifacts"],
          summary: "Download a definition document",
          description:
            "Returns the versioned definition document bytes from the descriptor's `downloadUrl` (here shown at the fixture's conventional location). Cyrnel hashes the bytes and refuses to install on mismatch. Artifacts may live off-origin; keep artifact URLs immutable per version.",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Entry slug from the browse page.",
            },
          ],
          responses: {
            200: {
              description:
                "Definition document (shape depends on the entry kind, e.g. an OpenAPI document for `openapi@3.0`).",
              content: {
                "application/json": {
                  schema: { type: "object" },
                },
              },
            },
            401: errorResponses(
              "A registry credential was required but missing or invalid.",
            ),
            404: errorResponses("The artifact could not be found."),
          },
        },
      },
      "/modules/{id}/archive.tar.zst": {
        get: {
          tags: ["Artifacts"],
          summary: "Download a module archive",
          description:
            "Returns the versioned `.tar.zst` module archive bytes from the descriptor's `downloadUrl` (here shown at the fixture's conventional location). Cyrnel hashes the bytes and refuses to install on mismatch.",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Entry slug from the browse page.",
            },
          ],
          responses: {
            200: {
              description: "Zstandard-compressed tar module archive.",
              content: {
                "application/zstd": {
                  schema: { type: "string", format: "binary" },
                },
              },
            },
            401: errorResponses(
              "A registry credential was required but missing or invalid.",
            ),
            404: errorResponses("The artifact could not be found."),
          },
        },
      },
      "/oauth/token": {
        post: {
          tags: ["Authentication"],
          summary: "Exchange an OAuth2 token",
          description:
            "Reference-fixture path; real registries advertise their own `tokenUrl` per oauth2 scheme. Cyrnel POSTs `application/x-www-form-urlencoded`, requires https when client secrets are involved, and refuses to follow redirects with credentials in the body. Only `access_token` is required in the response (`expires_in` defaults to one hour client-side).",
          requestBody: {
            required: true,
            content: {
              "application/x-www-form-urlencoded": {
                schema: ref("RegistryTokenRequest"),
              },
            },
          },
          responses: {
            200: {
              description: "Issued access token.",
              content: {
                "application/json": {
                  schema: ref("RegistryTokenResponse"),
                },
              },
            },
            400: errorResponses("The grant was invalid or unsupported."),
            401: errorResponses("Client authentication failed."),
          },
        },
      },
      "/oauth/authorize": {
        get: {
          tags: ["Authentication"],
          summary: "Open the authorization-code flow",
          description:
            "Reference-fixture path; real registries advertise their own `authorizationUrl` per oauth2 scheme supporting the authorization-code grant. This is a browser-facing entry point that redirects the operator to approve access; Cyrnel completes the flow at its `/auth/callback` redirect target. The fixture auto-approves.",
          parameters: [
            {
              name: "response_type",
              in: "query",
              required: true,
              schema: { type: "string", enum: ["code"] },
              description: "OAuth2 response type.",
            },
            {
              name: "client_id",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "OAuth2 client id.",
            },
            {
              name: "redirect_uri",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "Where to redirect with the issued code.",
            },
            {
              name: "scope",
              in: "query",
              schema: { type: "string" },
              description: "Space-delimited requested scopes.",
            },
            {
              name: "state",
              in: "query",
              schema: { type: "string" },
              description: "Opaque state echoed back to the redirect target.",
            },
            {
              name: "code_challenge",
              in: "query",
              schema: { type: "string" },
              description: "PKCE code challenge (S256).",
            },
            {
              name: "code_challenge_method",
              in: "query",
              schema: { type: "string", enum: ["S256"] },
              description: "PKCE challenge method.",
            },
          ],
          responses: {
            302: {
              description: "Redirect to the operator approval page.",
            },
            400: errorResponses("The authorization request was invalid."),
          },
        },
      },
    },
    components: {
      schemas,
      securitySchemes: {
        apiKey: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
          description:
            "Placeholder header name; real registries advertise their own `paramName` per apiKey scheme in the well-known document.",
        },
        basic: {
          type: "http",
          scheme: "basic",
          description: "HTTP Basic credentials per the advertised scheme.",
        },
        bearer: {
          type: "http",
          scheme: "bearer",
          description: "Bearer token per the advertised scheme.",
        },
        oauth2: {
          type: "oauth2",
          description:
            "OAuth2 per the advertised scheme. Flow URLs below are the reference fixture's; real registries advertise their own `tokenUrl` / `authorizationUrl`.",
          flows: {
            clientCredentials: {
              tokenUrl: `${FIXTURE_URL}/oauth/token`,
              scopes: {},
            },
            authorizationCode: {
              authorizationUrl: `${FIXTURE_URL}/oauth/authorize`,
              tokenUrl: `${FIXTURE_URL}/oauth/token`,
              scopes: {},
            },
          },
        },
      },
    },
  } as OpenAPIObject;
}
