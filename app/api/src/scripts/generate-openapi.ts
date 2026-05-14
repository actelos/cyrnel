import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { generateOpenApiDoc } from "@/openapi/generator";

const outputPath = resolve(process.cwd(), "../../docs/openapi.json");

mkdirSync(resolve(outputPath, ".."), { recursive: true });
writeFileSync(outputPath, JSON.stringify(generateOpenApiDoc(), null, 2));

console.log(`Wrote OpenAPI document to ${outputPath}`);
