import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { generateOpenApiDoc } from "./openapi-definition";

const outputPath = resolve(process.cwd(), "./openapi.json");

mkdirSync(resolve(outputPath, ".."), { recursive: true });
writeFileSync(outputPath, JSON.stringify(generateOpenApiDoc(), null, 2));
