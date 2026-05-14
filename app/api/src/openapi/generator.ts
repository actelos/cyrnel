import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";

import type { OpenAPIObject } from "openapi3-ts/oas30";

import { registry } from "@/openapi/registry";

export function generateOpenApiDoc(): OpenAPIObject {
  const generator = new OpenApiGeneratorV3(registry.definitions);

  return generator.generateDocument({
    openapi: "3.0.0",
    info: {
      title: "MCI API",
      description: "Model Control interface API",
      version: "1.0.0",
    },
    servers: [{ url: "http://localhost:7687" }],
  });
}
