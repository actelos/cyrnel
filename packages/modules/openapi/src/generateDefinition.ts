import type {
  JSONSchema,
  ServiceDefinition,
  ToolDefinition,
} from "@cyrnel/sdk";
import type { IJsonSchema, OpenAPIV3_1 } from "openapi-types";
import { parse as parseYaml } from "yaml";

type Doc = OpenAPIV3_1.Document;
type Operation = OpenAPIV3_1.OperationObject;
type ParameterObject = OpenAPIV3_1.ParameterObject;
type RequestBodyObject = OpenAPIV3_1.RequestBodyObject;
type ResponseObject = OpenAPIV3_1.ResponseObject;
type ReferenceObject = OpenAPIV3_1.ReferenceObject;
type SecuritySchemeObject = OpenAPIV3_1.SecuritySchemeObject;
type ServerVariableObject = OpenAPIV3_1.ServerVariableObject;

export function normalizeIdentifier(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (cleaned === "") return "_";

  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "options",
  "head",
  "trace",
] as const;

function isReference(obj: unknown): obj is ReferenceObject {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "$ref" in obj &&
    typeof (obj as ReferenceObject).$ref === "string"
  );
}

function resolveRef<T>(doc: Doc, ref: string): T {
  const path = ref.replace("#/", "").split("/");
  let current: unknown = doc;

  for (const segment of path) {
    if (typeof current !== "object" || current === null) {
      throw new Error(`Invalid $ref path: ${ref}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current as T;
}

function resolveAllRefs(
  doc: Doc,
  obj: unknown,
  visited: Set<string> = new Set(),
): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => resolveAllRefs(doc, item, visited));
  }

  if (isReference(obj)) {
    if (visited.has(obj.$ref)) {
      return {};
    }
    visited.add(obj.$ref);
    const resolved = resolveRef(doc, obj.$ref);
    return resolveAllRefs(doc, resolved, visited);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = resolveAllRefs(doc, value, visited);
  }
  return result;
}

function resolveSchema(doc: Doc, obj: unknown): IJsonSchema {
  return resolveAllRefs(doc, obj) as IJsonSchema;
}

function parseDocument(input: string): { doc: Doc; openapi: string } {
  const trimmed = input.trim();
  const parsed: unknown = trimmed.startsWith("{")
    ? JSON.parse(input)
    : parseYaml(input);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid OpenAPI document: expected an object");
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.openapi !== "string") {
    if (typeof obj.swagger === "string") {
      throw new Error(
        `Unsupported OpenAPI version "${obj.swagger}". Only 3.x is supported.`,
      );
    }
    throw new Error('Missing "openapi" field');
  }

  const openapi = obj.openapi;
  if (!/^3\.\d+(\.\d+)?$/.test(openapi)) {
    throw new Error(
      `Unsupported OpenAPI version "${openapi}". Only 3.x is supported.`,
    );
  }

  return { doc: obj as unknown as Doc, openapi };
}

const PARAM_GROUPS = {
  path: "path",
  query: "query",
  header: "headers",
  cookie: "cookies",
} as const;

type ParamLocation = keyof typeof PARAM_GROUPS;

function buildInputSchema(doc: Doc, operation: Operation): JSONSchema {
  const groups: Record<
    ParamLocation,
    { properties: Record<string, IJsonSchema>; required: string[] }
  > = {
    path: { properties: {}, required: [] },
    query: { properties: {}, required: [] },
    header: { properties: {}, required: [] },
    cookie: { properties: {}, required: [] },
  };

  if (operation.parameters) {
    for (const param of operation.parameters) {
      const resolved = resolveAllRefs(doc, param) as ParameterObject;
      const group = groups[resolved.in as ParamLocation];
      if (!group || !resolved.schema) continue;
      group.properties[resolved.name] = resolveSchema(doc, resolved.schema);
      if (resolved.required) {
        group.required.push(resolved.name);
      }
    }
  }

  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];

  for (const [inValue, slotKey] of Object.entries(PARAM_GROUPS) as [
    ParamLocation,
    string,
  ][]) {
    const group = groups[inValue];
    if (Object.keys(group.properties).length === 0) continue;
    const slot: JSONSchema = {
      type: "object",
      properties: group.properties,
    };
    if (group.required.length > 0) {
      slot.required = group.required;
      required.push(slotKey);
    }
    properties[slotKey] = slot;
  }

  if (operation.requestBody) {
    const resolvedBody = resolveAllRefs(
      doc,
      operation.requestBody,
    ) as RequestBodyObject;
    const content = resolvedBody.content;
    if (content) {
      const mediaType =
        content["application/json"] ?? Object.values(content)[0];
      if (mediaType?.schema) {
        properties.body = resolveSchema(doc, mediaType.schema) as JSONSchema;
        if (resolvedBody.required) {
          required.push("body");
        }
      }
    }
  }

  const schema: JSONSchema = {
    type: "object",
    properties,
  };

  if (required.length > 0) {
    schema.required = required;
  }

  return schema;
}

const RESPONSE_CODE_PATTERN = /^(default|[1-5](XX|\d\d))$/;

function buildResponseBranch(
  doc: Doc,
  code: string,
  response: ReferenceObject | ResponseObject,
): JSONSchema {
  const resolved = resolveAllRefs(doc, response) as ResponseObject;

  let bodySchema: IJsonSchema | null = null;
  if (resolved.content) {
    const mediaType =
      resolved.content["application/json"] ??
      Object.values(resolved.content)[0];
    if (mediaType?.schema) {
      bodySchema = resolveSchema(doc, mediaType.schema);
    }
  }

  if (bodySchema) {
    return {
      type: "object",
      properties: {
        status: { const: code },
        body: bodySchema,
      },
      required: ["status", "body"],
    };
  }

  return {
    type: "object",
    properties: { status: { const: code } },
    required: ["status"],
  };
}

function buildOutputSchema(doc: Doc, operation: Operation): JSONSchema {
  if (!operation.responses) {
    return {};
  }

  const branches: JSONSchema[] = [];

  for (const [code, response] of Object.entries(operation.responses)) {
    if (!response || !RESPONSE_CODE_PATTERN.test(code)) continue;
    branches.push(buildResponseBranch(doc, code, response));
  }

  if (branches.length === 0) return {};
  if (branches.length === 1) return branches[0];
  return { oneOf: branches };
}

function extractToolDescription(operation: Operation): string {
  if (operation.requestBody && !isReference(operation.requestBody)) {
    if (operation.requestBody.description) {
      return operation.requestBody.description;
    }
  }
  return operation.description ?? "";
}

function buildConfigSchema(doc: Doc): JSONSchema {
  const properties: Record<string, JSONSchema> = {
    timeoutMs: {
      type: "integer",
      default: 30000,
      minimum: 1,
      description: "Request timeout in milliseconds",
    },
  };

  const servers = doc.servers ?? [];
  if (servers.length > 0) {
    properties.serverUrl = {
      type: "string",
      description:
        "Base URL override. Uses the first server from the spec if not set.",
    };

    const varNames = new Set<string>();
    for (const server of servers) {
      if (server.variables) {
        for (const [name, variable] of Object.entries(server.variables)) {
          if (varNames.has(name)) continue;
          varNames.add(name);
          const resolved = resolveAllRefs(
            doc,
            variable,
          ) as ServerVariableObject;
          const prop: JSONSchema = { type: "string" };
          if (resolved.default !== undefined) prop.default = resolved.default;
          if (resolved.enum) prop.enum = resolved.enum;
          properties[`serverVar_${name}`] = prop;
        }
      }
    }
  }

  return {
    type: "object",
    properties,
    additionalProperties: false,
  };
}

function buildSecretsSchema(doc: Doc): JSONSchema {
  const securitySchemes = doc.components?.securitySchemes;
  if (
    !securitySchemes ||
    (typeof securitySchemes === "object" &&
      Object.keys(securitySchemes).length === 0)
  ) {
    return { type: "object", properties: {}, additionalProperties: false };
  }

  const properties: Record<string, JSONSchema> = {};

  for (const [name, schemeOrRef] of Object.entries(securitySchemes)) {
    if (!schemeOrRef) continue;
    const resolved = resolveAllRefs(doc, schemeOrRef) as SecuritySchemeObject;

    switch (resolved.type) {
      case "apiKey":
        properties[name] = {
          type: "string",
          description:
            resolved.description ?? `${resolved.name} (${resolved.in})`,
        };
        break;
      case "http":
        if (resolved.scheme === "bearer") {
          properties[name] = {
            type: "string",
            description: resolved.description ?? "Bearer token",
          };
        } else if (resolved.scheme === "basic") {
          properties[name] = {
            type: "object",
            properties: {
              username: { type: "string" },
              password: { type: "string" },
            },
            required: ["username", "password"],
            description:
              resolved.description ??
              "Basic auth credentials (username & password)",
          };
        } else {
          properties[name] = {
            type: "string",
            description: resolved.description ?? `HTTP ${resolved.scheme} auth`,
          };
        }
        break;
      case "oauth2":
        properties[name] = {
          type: "string",
          description: resolved.description ?? "OAuth2 access token",
        };
        break;
      case "openIdConnect":
        properties[name] = {
          type: "string",
          description: resolved.description ?? "OpenID Connect token",
        };
        break;
    }
  }

  return {
    type: "object",
    properties,
    additionalProperties: false,
  };
}

export async function generateDefinition(
  input: string,
): Promise<ServiceDefinition> {
  const { doc, openapi } = parseDocument(input);

  const tools: ToolDefinition[] = [];

  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    if (!pathItem) continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation?.responses) {
        continue;
      }

      if (!operation.operationId) {
        throw new Error(
          `OpenAPI operationId is required for ${method.toUpperCase()} ${path}`,
        );
      }

      const id = normalizeIdentifier(operation.operationId);
      const name = operation.summary ?? id;
      const summary = operation.summary ?? "";
      const description = extractToolDescription(operation);

      const inputSchema = buildInputSchema(doc, operation);
      const outputSchema = buildOutputSchema(doc, operation);

      const operationSecurity = operation.security ?? doc.security ?? [];
      tools.push({
        id,
        name,
        summary,
        description,
        inputSchema,
        outputSchema,
        adapterDomain: {
          path,
          method,
          security: operationSecurity,
        },
      });
    }
  }

  const adapterDomain: Record<string, unknown> = {
    openapi,
    servers: doc.servers ?? [],
  };

  if (doc.components?.securitySchemes) {
    adapterDomain.securitySchemes = resolveAllRefs(
      doc,
      doc.components.securitySchemes,
    ) as Record<string, unknown>;
  }

  return {
    name: doc.info.title,
    summary: doc.info.summary ?? "",
    description: doc.info.description ?? "",
    tools,
    configSchema: buildConfigSchema(doc),
    secretsSchema: buildSecretsSchema(doc),
    adapterDomain,
  };
}
