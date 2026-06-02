import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { generateDefinition } from "@/generateDefinition";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures");

async function loadFixture(name: string): Promise<string> {
  return readFile(join(fixturesDir, name), "utf-8");
}

describe("generateDefinition integration", () => {
  describe("petstore.json fixture", () => {
    it("generates correct service definition from full petstore spec", async () => {
      const spec = await loadFixture("petstore.json");

      const result = await generateDefinition(spec);

      expect(result.name).toBe("Petstore API");
      expect(result.description).toBe(
        "A sample API that uses a petstore as an example to demonstrate features in OpenAPI 3.0",
      );
    });

    it("extracts all 5 tools from petstore paths", async () => {
      const spec = await loadFixture("petstore.json");

      const result = await generateDefinition(spec);

      expect(result.tools).toHaveLength(5);
      expect(result.tools.map((t) => t.id).sort()).toEqual([
        "createPet",
        "deletePet",
        "getPetById",
        "listPets",
        "updatePet",
      ]);
    });

    it("resolves $ref in parameters correctly", async () => {
      const spec = await loadFixture("petstore.json");

      const result = await generateDefinition(spec);

      const getPetTool = result.tools.find((t) => t.id === "getPetById");
      expect(getPetTool).toBeDefined();
      expect(getPetTool?.inputSchema).toEqual({
        type: "object",
        properties: {
          path: {
            type: "object",
            properties: { petId: { type: "string", format: "uuid" } },
            required: ["petId"],
          },
        },
        required: ["path"],
      });
    });

    it("resolves nested $ref in response schema", async () => {
      const spec = await loadFixture("petstore.json");

      const result = await generateDefinition(spec);

      const getPetTool = result.tools.find((t) => t.id === "getPetById");
      expect(getPetTool).toBeDefined();
      expect(getPetTool?.outputSchema).toEqual({
        oneOf: [
          {
            type: "object",
            properties: {
              status: { const: "200" },
              body: {
                type: "object",
                required: ["id", "name"],
                properties: {
                  id: { type: "string", format: "uuid" },
                  name: { type: "string" },
                  species: { type: "string" },
                  owner: {
                    type: "object",
                    properties: {
                      id: { type: "string", format: "uuid" },
                      name: { type: "string" },
                      email: { type: "string", format: "email" },
                    },
                  },
                  createdAt: { type: "string", format: "date-time" },
                },
              },
            },
            required: ["status", "body"],
          },
          {
            type: "object",
            properties: { status: { const: "404" } },
            required: ["status"],
          },
        ],
      });
    });

    it("correctly builds inputSchema with path params and requestBody", async () => {
      const spec = await loadFixture("petstore.json");

      const result = await generateDefinition(spec);

      const updatePetTool = result.tools.find((t) => t.id === "updatePet");
      expect(updatePetTool).toBeDefined();
      expect(updatePetTool?.inputSchema).toEqual({
        type: "object",
        properties: {
          path: {
            type: "object",
            properties: { petId: { type: "string", format: "uuid" } },
            required: ["petId"],
          },
          body: {
            type: "object",
            properties: {
              name: { type: "string" },
              species: { type: "string" },
              ownerId: { type: "string", format: "uuid" },
            },
            required: ["name"],
          },
        },
        required: ["path", "body"],
      });
    });

    it("extracts tool description from requestBody.description", async () => {
      const spec = await loadFixture("petstore.json");

      const result = await generateDefinition(spec);

      const createPetTool = result.tools.find((t) => t.id === "createPet");
      expect(createPetTool).toBeDefined();
      expect(createPetTool?.description).toBe("Pet to add to the store");
    });

    it("uses operation description when requestBody.description is missing", async () => {
      const spec = await loadFixture("petstore.json");

      const result = await generateDefinition(spec);

      const listPetsTool = result.tools.find((t) => t.id === "listPets");
      expect(listPetsTool).toBeDefined();
      expect(listPetsTool?.description).toBe(
        "Returns all pets from the system that the user has access to",
      );
    });

    it("includes servers in adapterDomain", async () => {
      const spec = await loadFixture("petstore.json");

      const result = await generateDefinition(spec);

      expect(result.adapterDomain).toEqual({
        openapi: "3.0.3",
        servers: [{ url: "https://petstore.example.com/api/v1" }],
      });
    });

    it("includes path and method in tool adapterDomain", async () => {
      const spec = await loadFixture("petstore.json");

      const result = await generateDefinition(spec);

      const deletePetTool = result.tools.find((t) => t.id === "deletePet");
      expect(deletePetTool).toBeDefined();
      expect(deletePetTool?.adapterDomain).toEqual({
        path: "/pets/{petId}",
        method: "delete",
      });
    });

    it("handles operations without response content (204)", async () => {
      const spec = await loadFixture("petstore.json");

      const result = await generateDefinition(spec);

      const deletePetTool = result.tools.find((t) => t.id === "deletePet");
      expect(deletePetTool).toBeDefined();
      expect(deletePetTool?.outputSchema).toEqual({
        type: "object",
        properties: { status: { const: "204" } },
        required: ["status"],
      });
    });
  });

  describe("petstore.yaml fixture", () => {
    it("parses YAML format correctly", async () => {
      const spec = await loadFixture("petstore.yaml");

      const result = await generateDefinition(spec);

      expect(result.name).toBe("Petstore API (YAML)");
      expect(result.description).toBe("A sample API in YAML format");
    });

    it("resolves $ref in YAML format", async () => {
      const spec = await loadFixture("petstore.yaml");

      const result = await generateDefinition(spec);

      const listPetsTool = result.tools.find((t) => t.id === "listPets");
      expect(listPetsTool).toBeDefined();
      expect(listPetsTool?.outputSchema).toEqual({
        type: "object",
        properties: {
          status: { const: "200" },
          body: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
              },
            },
          },
        },
        required: ["status", "body"],
      });
    });
  });
});
