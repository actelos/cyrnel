import { describe, expect, it } from "vitest";

import { generateDefinition, normalizeIdentifier } from "@/generateDefinition";

describe("generateDefinition", () => {
  describe("service metadata", () => {
    it("extracts name from info.title", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Pet Store API", version: "1.0.0" },
        paths: {},
      });

      const result = await generateDefinition(spec);

      expect(result.name).toBe("Pet Store API");
    });

    it("extracts description from info.description", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: {
          title: "Pet Store API",
          description: "A sample API for pet store operations",
          version: "1.0.0",
        },
        paths: {},
      });

      const result = await generateDefinition(spec);

      expect(result.description).toBe("A sample API for pet store operations");
    });

    it("uses empty string when description is missing", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Pet Store API", version: "1.0.0" },
        paths: {},
      });

      const result = await generateDefinition(spec);

      expect(result.description).toBe("");
    });

    it("extracts summary from info.summary", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: {
          title: "Pet Store API",
          summary: "Manage pets in the store",
          version: "1.0.0",
        },
        paths: {},
      });

      const result = await generateDefinition(spec);

      expect(result.summary).toBe("Manage pets in the store");
    });

    it("uses empty string when summary is missing", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: {
          title: "Pet Store API",
          description: "A sample API for pet store operations",
          version: "1.0.0",
        },
        paths: {},
      });

      const result = await generateDefinition(spec);

      expect(result.summary).toBe("");
      expect(result.description).toBe("A sample API for pet store operations");
    });

    it("keeps summary and description separate", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: {
          title: "Pet Store API",
          summary: "Manages pets",
          description: "A sample API for pet store operations",
          version: "1.0.0",
        },
        paths: {},
      });

      const result = await generateDefinition(spec);

      expect(result.summary).toBe("Manages pets");
      expect(result.description).toBe("A sample API for pet store operations");
    });
  });

  describe("tool extraction from paths", () => {
    it("extracts tool id from operationId", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              summary: "List all pets",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].id).toBe("listPets");
    });

    it("normalizes dotted operationIds to valid identifiers", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/users/messages": {
            get: {
              operationId: "gmail.users.messages.list",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].id).toBe("gmail_users_messages_list");
    });

    it("extracts tool name from summary", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              summary: "List all pets",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].name).toBe("List all pets");
    });

    it("extracts tool summary from operation.summary", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              summary: "List all pets",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].summary).toBe("List all pets");
    });

    it("uses empty string for tool summary when missing", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].summary).toBe("");
    });

    it("extracts tool description from requestBody.description", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets": {
            post: {
              operationId: "createPet",
              summary: "Create a pet",
              requestBody: {
                description: "Pet object to be created",
                content: {
                  "application/json": {
                    schema: { type: "object" },
                  },
                },
              },
              responses: { "201": { description: "Created" } },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].description).toBe("Pet object to be created");
    });

    it("uses operation description when requestBody.description is missing", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              summary: "List all pets",
              description: "Returns a list of all pets in the store",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].description).toBe(
        "Returns a list of all pets in the store",
      );
    });

    it("extracts multiple tools from different HTTP methods", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              summary: "List pets",
              responses: { "200": { description: "OK" } },
            },
            post: {
              operationId: "createPet",
              summary: "Create pet",
              responses: { "201": { description: "Created" } },
            },
          },
          "/pets/{id}": {
            get: {
              operationId: "getPet",
              summary: "Get pet",
              responses: { "200": { description: "OK" } },
            },
            delete: {
              operationId: "deletePet",
              summary: "Delete pet",
              responses: { "204": { description: "Deleted" } },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools).toHaveLength(4);
      expect(result.tools.map((t) => t.id)).toEqual([
        "listPets",
        "createPet",
        "getPet",
        "deletePet",
      ]);
    });
  });

  describe("inputSchema namespaced by parameter location", () => {
    it("places path parameters under the `path` slot", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets/{petId}": {
            get: {
              operationId: "getPet",
              summary: "Get a pet",
              parameters: [
                {
                  name: "petId",
                  in: "path",
                  required: true,
                  schema: { type: "string" },
                },
              ],
              responses: { "200": { description: "OK" } },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].inputSchema).toEqual({
        type: "object",
        properties: {
          path: {
            type: "object",
            properties: { petId: { type: "string" } },
            required: ["petId"],
          },
        },
        required: ["path"],
      });
    });

    it("places query parameters under the `query` slot with mixed required", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              summary: "List pets",
              parameters: [
                {
                  name: "limit",
                  in: "query",
                  required: false,
                  schema: { type: "integer" },
                },
                {
                  name: "status",
                  in: "query",
                  required: true,
                  schema: { type: "string" },
                },
              ],
              responses: { "200": { description: "OK" } },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].inputSchema).toEqual({
        type: "object",
        properties: {
          query: {
            type: "object",
            properties: {
              limit: { type: "integer" },
              status: { type: "string" },
            },
            required: ["status"],
          },
        },
        required: ["query"],
      });
    });

    it("omits the `query` slot from required when all query params are optional", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              summary: "List pets",
              parameters: [
                {
                  name: "limit",
                  in: "query",
                  required: false,
                  schema: { type: "integer" },
                },
              ],
              responses: { "200": { description: "OK" } },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].inputSchema).toEqual({
        type: "object",
        properties: {
          query: {
            type: "object",
            properties: { limit: { type: "integer" } },
          },
        },
      });
    });

    it("places header and cookie parameters in their own slots", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              summary: "List pets",
              parameters: [
                {
                  name: "X-Request-Id",
                  in: "header",
                  required: true,
                  schema: { type: "string" },
                },
                {
                  name: "session",
                  in: "cookie",
                  required: false,
                  schema: { type: "string" },
                },
              ],
              responses: { "200": { description: "OK" } },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].inputSchema).toEqual({
        type: "object",
        properties: {
          headers: {
            type: "object",
            properties: { "X-Request-Id": { type: "string" } },
            required: ["X-Request-Id"],
          },
          cookies: {
            type: "object",
            properties: { session: { type: "string" } },
          },
        },
        required: ["headers"],
      });
    });

    it("places requestBody schema (object) under the `body` slot", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets": {
            post: {
              operationId: "createPet",
              summary: "Create a pet",
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        age: { type: "integer" },
                      },
                      required: ["name"],
                    },
                  },
                },
              },
              responses: { "201": { description: "Created" } },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].inputSchema).toEqual({
        type: "object",
        properties: {
          body: {
            type: "object",
            properties: {
              name: { type: "string" },
              age: { type: "integer" },
            },
            required: ["name"],
          },
        },
        required: ["body"],
      });
    });

    it("preserves non-object request bodies under the `body` slot as-is", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/notes": {
            post: {
              operationId: "addNote",
              summary: "Add a raw text note",
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: { type: "string" },
                  },
                },
              },
              responses: { "201": { description: "Created" } },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].inputSchema).toEqual({
        type: "object",
        properties: {
          body: { type: "string" },
        },
        required: ["body"],
      });
    });

    it("omits `body` from required when requestBody.required is false", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets": {
            post: {
              operationId: "createPet",
              summary: "Create a pet",
              requestBody: {
                content: {
                  "application/json": {
                    schema: { type: "object", properties: {} },
                  },
                },
              },
              responses: { "201": { description: "Created" } },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].inputSchema).toEqual({
        type: "object",
        properties: {
          body: { type: "object", properties: {} },
        },
      });
    });

    it("keeps path and body separate when they share a parameter name", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/users/{userId}": {
            put: {
              operationId: "updateUser",
              summary: "Update a user",
              parameters: [
                {
                  name: "userId",
                  in: "path",
                  required: true,
                  schema: { type: "string", format: "uuid" },
                },
              ],
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        userId: { type: "string" },
                        name: { type: "string" },
                      },
                    },
                  },
                },
              },
              responses: { "200": { description: "OK" } },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].inputSchema).toEqual({
        type: "object",
        properties: {
          path: {
            type: "object",
            properties: { userId: { type: "string", format: "uuid" } },
            required: ["userId"],
          },
          body: {
            type: "object",
            properties: {
              userId: { type: "string" },
              name: { type: "string" },
            },
          },
        },
        required: ["path", "body"],
      });
    });
  });

  describe("outputSchema from responses", () => {
    it("wraps a single response with a body in a discriminated branch", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets/{id}": {
            get: {
              operationId: "getPet",
              summary: "Get a pet",
              responses: {
                "200": {
                  description: "OK",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          name: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].outputSchema).toEqual({
        type: "object",
        properties: {
          status: { const: "200" },
          body: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
        },
        required: ["status", "body"],
      });
    });

    it("omits body for responses with no content (e.g. 204)", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets/{id}": {
            delete: {
              operationId: "deletePet",
              summary: "Delete a pet",
              responses: {
                "204": { description: "No Content" },
              },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].outputSchema).toEqual({
        type: "object",
        properties: { status: { const: "204" } },
        required: ["status"],
      });
    });

    it("returns oneOf over all responses including errors", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets/{id}": {
            get: {
              operationId: "getPet",
              summary: "Get a pet",
              responses: {
                "200": {
                  description: "OK",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: { id: { type: "string" } },
                      },
                    },
                  },
                },
                "404": {
                  description: "Not Found",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: { message: { type: "string" } },
                      },
                    },
                  },
                },
                "500": { description: "Server Error" },
              },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].outputSchema).toEqual({
        oneOf: [
          {
            type: "object",
            properties: {
              status: { const: "200" },
              body: {
                type: "object",
                properties: { id: { type: "string" } },
              },
            },
            required: ["status", "body"],
          },
          {
            type: "object",
            properties: {
              status: { const: "404" },
              body: {
                type: "object",
                properties: { message: { type: "string" } },
              },
            },
            required: ["status", "body"],
          },
          {
            type: "object",
            properties: { status: { const: "500" } },
            required: ["status"],
          },
        ],
      });
    });

    it("includes default and range codes (XX) as discriminator values", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              summary: "List pets",
              responses: {
                "200": { description: "OK" },
                "4XX": { description: "Client error" },
                default: { description: "Fallback" },
              },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].outputSchema).toEqual({
        oneOf: [
          {
            type: "object",
            properties: { status: { const: "200" } },
            required: ["status"],
          },
          {
            type: "object",
            properties: { status: { const: "4XX" } },
            required: ["status"],
          },
          {
            type: "object",
            properties: { status: { const: "default" } },
            required: ["status"],
          },
        ],
      });
    });

    it("ignores spec extensions (x-*) in responses", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              summary: "List pets",
              responses: {
                "200": { description: "OK" },
                "x-internal": { description: "Not a real response" },
              },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].outputSchema).toEqual({
        type: "object",
        properties: { status: { const: "200" } },
        required: ["status"],
      });
    });
  });

  describe("$ref resolution", () => {
    it("resolves $ref in parameters", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets/{petId}": {
            get: {
              operationId: "getPet",
              summary: "Get a pet",
              parameters: [{ $ref: "#/components/parameters/PetId" }],
              responses: { "200": { description: "OK" } },
            },
          },
        },
        components: {
          parameters: {
            PetId: {
              name: "petId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].inputSchema).toEqual({
        type: "object",
        properties: {
          path: {
            type: "object",
            properties: { petId: { type: "string" } },
            required: ["petId"],
          },
        },
        required: ["path"],
      });
    });

    it("resolves $ref in requestBody schema", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets": {
            post: {
              operationId: "createPet",
              summary: "Create a pet",
              requestBody: {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Pet" },
                  },
                },
              },
              responses: { "201": { description: "Created" } },
            },
          },
        },
        components: {
          schemas: {
            Pet: {
              type: "object",
              properties: {
                name: { type: "string" },
                species: { type: "string" },
              },
              required: ["name"],
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].inputSchema).toEqual({
        type: "object",
        properties: {
          body: {
            type: "object",
            properties: {
              name: { type: "string" },
              species: { type: "string" },
            },
            required: ["name"],
          },
        },
      });
    });

    it("resolves nested $ref", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets": {
            post: {
              operationId: "createPet",
              summary: "Create a pet",
              requestBody: {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Pet" },
                  },
                },
              },
              responses: { "201": { description: "Created" } },
            },
          },
        },
        components: {
          schemas: {
            Pet: {
              type: "object",
              properties: {
                name: { type: "string" },
                owner: { $ref: "#/components/schemas/Owner" },
              },
            },
            Owner: {
              type: "object",
              properties: {
                name: { type: "string" },
                email: { type: "string" },
              },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].inputSchema).toEqual({
        type: "object",
        properties: {
          body: {
            type: "object",
            properties: {
              name: { type: "string" },
              owner: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  email: { type: "string" },
                },
              },
            },
          },
        },
      });
    });

    it("resolves $ref in response schema", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets/{id}": {
            get: {
              operationId: "getPet",
              summary: "Get a pet",
              responses: {
                "200": {
                  description: "OK",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Pet" },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            Pet: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
              },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].outputSchema).toEqual({
        type: "object",
        properties: {
          status: { const: "200" },
          body: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
        },
        required: ["status", "body"],
      });
    });
  });

  describe("adapterDomain", () => {
    it("includes path and method in tool adapterDomain", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets/{petId}": {
            get: {
              operationId: "getPet",
              summary: "Get a pet",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].adapterDomain).toMatchObject({
        path: "/pets/{petId}",
        method: "get",
      });
    });

    it("includes empty security array in tool adapterDomain when no security is defined", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              summary: "List pets",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].adapterDomain).toMatchObject({
        security: [],
      });
    });

    it("includes security from operation-level override", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              summary: "List pets",
              security: [{ apiKey: [] }],
              responses: { "200": { description: "OK" } },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].adapterDomain).toMatchObject({
        security: [{ apiKey: [] }],
      });
    });

    it("includes servers in service adapterDomain", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        servers: [{ url: "https://api.example.com/v1" }],
        paths: {},
      });

      const result = await generateDefinition(spec);

      expect(result.adapterDomain).toMatchObject({
        openapi: "3.0.0",
        servers: [{ url: "https://api.example.com/v1" }],
      });
    });

    it("includes openapi version in service adapterDomain", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.3",
        info: { title: "API", version: "1.0.0" },
        paths: {},
      });

      const result = await generateDefinition(spec);

      expect(result.adapterDomain).toMatchObject({
        openapi: "3.0.3",
        servers: [],
      });
    });

    it("omits securitySchemes in service adapterDomain when none are defined", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {},
      });

      const result = await generateDefinition(spec);

      expect(result.adapterDomain).not.toHaveProperty("securitySchemes");
    });

    it("includes resolved securitySchemes in service adapterDomain", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {},
        components: {
          securitySchemes: {
            ApiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
            Bearer: { type: "http", scheme: "bearer" },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.adapterDomain).toMatchObject({
        securitySchemes: {
          ApiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
          Bearer: { type: "http", scheme: "bearer" },
        },
      });
    });
  });

  describe("OpenAPI version handling", () => {
    it("accepts OpenAPI 3.0.x documents", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.3",
        info: { title: "API", version: "1.0.0" },
        paths: {},
      });

      const result = await generateDefinition(spec);

      expect(result.adapterDomain).toMatchObject({ openapi: "3.0.3" });
    });

    it("accepts OpenAPI 3.1.x documents", async () => {
      const spec = JSON.stringify({
        openapi: "3.1.0",
        info: { title: "API", version: "1.0.0" },
        paths: {},
      });

      const result = await generateDefinition(spec);

      expect(result.adapterDomain).toMatchObject({ openapi: "3.1.0" });
    });

    it("accepts OpenAPI 3.2.x documents (treated as 3.1-compatible)", async () => {
      const spec = JSON.stringify({
        openapi: "3.2.0",
        info: { title: "API", version: "1.0.0" },
        paths: {},
      });

      const result = await generateDefinition(spec);

      expect(result.adapterDomain).toMatchObject({ openapi: "3.2.0" });
    });

    it("rejects Swagger 2.0 documents", async () => {
      const spec = JSON.stringify({
        swagger: "2.0",
        info: { title: "API", version: "1.0.0" },
        paths: {},
      });

      await expect(generateDefinition(spec)).rejects.toThrow(
        'Unsupported OpenAPI version "2.0". Only 3.x is supported.',
      );
    });

    it("rejects documents with missing openapi field", async () => {
      const spec = JSON.stringify({
        info: { title: "API", version: "1.0.0" },
        paths: {},
      });

      await expect(generateDefinition(spec)).rejects.toThrow(
        'Missing "openapi" field',
      );
    });

    it("rejects OpenAPI 4.x documents", async () => {
      const spec = JSON.stringify({
        openapi: "4.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {},
      });

      await expect(generateDefinition(spec)).rejects.toThrow(
        'Unsupported OpenAPI version "4.0.0". Only 3.x is supported.',
      );
    });
  });

  describe("schema defaults", () => {
    it("returns configSchema with default timeout and no servers", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {},
      });

      const result = await generateDefinition(spec);

      expect(result.configSchema).toEqual({
        type: "object",
        properties: {
          timeoutMs: {
            type: "integer",
            default: 30000,
            minimum: 1,
            description: "Request timeout in milliseconds",
          },
        },
        additionalProperties: false,
      });
    });

    it("returns empty secretsSchema when no securitySchemes are defined", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {},
      });

      const result = await generateDefinition(spec);

      expect(result.secretsSchema).toEqual({
        type: "object",
        properties: {},
        additionalProperties: false,
      });
    });

    it("includes serverUrl and serverVar fields in configSchema when servers have variables", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        servers: [
          {
            url: "https://{environment}.example.com/{version}",
            variables: {
              environment: {
                default: "api",
                enum: ["api", "staging"],
              },
              version: {
                default: "v2",
              },
            },
          },
        ],
        paths: {},
      });

      const result = await generateDefinition(spec);

      expect(result.configSchema).toMatchObject({
        type: "object",
        properties: {
          timeoutMs: { type: "integer" },
          serverUrl: { type: "string" },
          serverVar_environment: {
            type: "string",
            default: "api",
            enum: ["api", "staging"],
          },
          serverVar_version: {
            type: "string",
            default: "v2",
          },
        },
      });
    });

    it("generates secretsSchema from securitySchemes", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {},
        components: {
          securitySchemes: {
            ApiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
            BearerToken: { type: "http", scheme: "bearer" },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.secretsSchema).toMatchObject({
        type: "object",
        properties: {
          ApiKey: { type: "string" },
          BearerToken: { type: "string" },
        },
        additionalProperties: false,
      });
    });
  });

  describe("edge cases", () => {
    it("handles YAML input", async () => {
      const yamlSpec = `
openapi: "3.0.0"
info:
  title: "Pet Store API"
  version: "1.0.0"
paths: {}
`;

      const result = await generateDefinition(yamlSpec);

      expect(result.name).toBe("Pet Store API");
    });

    it("throws when operationId is missing", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets": {
            get: {
              summary: "List pets",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      });

      await expect(generateDefinition(spec)).rejects.toThrow(
        "OpenAPI operationId is required for GET /pets",
      );
    });

    it("uses operationId as name when summary is missing", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools[0].name).toBe("listPets");
    });

    it("skips operations without responses", async () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              summary: "List pets",
            },
          },
        },
      });

      const result = await generateDefinition(spec);

      expect(result.tools).toHaveLength(0);
    });
  });

  describe("normalizeIdentifier", () => {
    describe("valid identifiers pass through unchanged", () => {
      it.each([
        ["listPets"],
        ["ListPets"],
        ["list_pets"],
        ["listPets123"],
        ["list_Pets123"],
        ["GET_USERS"],
        ["getUsersByID"],
        ["a"],
        ["Z"],
        ["_"],
        ["simple"],
      ])("%s", (input) => {
        expect(normalizeIdentifier(input)).toBe(input);
      });
    });

    describe("dots become underscores", () => {
      it.each([
        ["gmail.users.messages.list", "gmail_users_messages_list"],
        ["a.b.c", "a_b_c"],
        ["one.two", "one_two"],
      ])("%s -> %s", (input, expected) => {
        expect(normalizeIdentifier(input)).toBe(expected);
      });
    });

    describe("hyphens and other non-alphanumeric chars become underscores", () => {
      it.each([
        ["user-name", "user_name"],
        ["user name", "user_name"],
        ["user@name", "user_name"],
        ["user#name", "user_name"],
        ["user!name", "user_name"],
        ["user(name)", "user_name"],
      ])("%s -> %s", (input, expected) => {
        expect(normalizeIdentifier(input)).toBe(expected);
      });
    });

    describe("consecutive special chars collapse", () => {
      it.each([
        ["a__b", "a_b"],
        ["a___b", "a_b"],
        ["a_-_b", "a_b"],
        ["a!@#b", "a_b"],
      ])("%s -> %s", (input, expected) => {
        expect(normalizeIdentifier(input)).toBe(expected);
      });
    });

    describe("leading/trailing special chars are stripped", () => {
      it.each([
        ["_listPets", "listPets"],
        ["$listPets", "listPets"],
        ["listPets_", "listPets"],
        ["listPets$", "listPets"],
        ["_listPets_", "listPets"],
        ["$listPets$", "listPets"],
        ["___listPets___", "listPets"],
        ["_", "_"],
        ["$", "_"],
        ["_$", "_"],
        ["$$$", "_"],
      ])("%s -> %s", (input, expected) => {
        expect(normalizeIdentifier(input)).toBe(expected);
      });
    });

    describe("leading digit gets underscore prefix", () => {
      it.each([
        ["123listPets", "_123listPets"],
        ["0test", "_0test"],
        ["42", "_42"],
        ["9", "_9"],
      ])("%s -> %s", (input, expected) => {
        expect(normalizeIdentifier(input)).toBe(expected);
      });
    });

    describe("combined edge cases", () => {
      it.each([
        ["_123abc", "_123abc"],
        ["$_123", "_123"],
        ["123_abc", "_123_abc"],
        ["a_1_b", "a_1_b"],
        ["__hello__world__", "hello_world"],
        ["$99problems", "_99problems"],
        ["_99problems", "_99problems"],
      ])("%s -> %s", (input, expected) => {
        expect(normalizeIdentifier(input)).toBe(expected);
      });
    });

    describe("empty and special-only input", () => {
      it.each([
        ["", "_"],
        ["___", "_"],
        ["!@#$%", "_"],
        ["   ", "_"],
        ["\n\t", "_"],
      ])("normalizeIdentifier(%j) -> %s", (input, expected) => {
        expect(normalizeIdentifier(input)).toBe(expected);
      });
    });

    describe("unicode and non-ASCII", () => {
      it.each([
        ["café", "caf"],
        ["über", "ber"],
        ["naïve", "na_ve"],
        ["用户", "_"],
        ["東京", "_"],
      ])("%s -> %s", (input, expected) => {
        expect(normalizeIdentifier(input)).toBe(expected);
      });
    });

    describe("dollar signs are treated as special chars", () => {
      it.each([
        ["a$b$c", "a_b_c"],
        ["get$Data", "get_Data"],
        ["a$$b", "a_b"],
      ])("%s -> %s", (input, expected) => {
        expect(normalizeIdentifier(input)).toBe(expected);
      });
    });

    describe("long complex string", () => {
      it("handles deeply nested path-like identifiers", () => {
        const result = normalizeIdentifier(
          "api.v2.users.{userId}.messages.list",
        );
        expect(result).toBe("api_v2_users_userId_messages_list");
      });

      it("handles string with multiple special chars and digits mixed", () => {
        const result = normalizeIdentifier("__getUser__By__Id_123!!");
        expect(result).toBe("getUser_By_Id_123");
      });
    });
  });
});
