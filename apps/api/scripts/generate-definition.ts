import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { generateOpenApiDoc } from "./openapi-definition";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outputPaths =
  outIndex !== -1
    ? args.slice(outIndex + 1).filter((a) => !a.startsWith("--"))
    : [resolve(process.cwd(), "./openapi.json")];

if (outputPaths.length === 0) {
  throw new Error(
    "Expected at least one path after --out, or omit --out to use the default.",
  );
}

const doc = JSON.stringify(generateOpenApiDoc(), null, 2);

for (const outputPath of outputPaths) {
  const resolved = resolve(process.cwd(), outputPath);
  mkdirSync(resolve(resolved, ".."), { recursive: true });
  writeFileSync(resolved, doc);
}
