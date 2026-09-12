import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { generateOpenApiDoc } from "./openapi-definition";
import { generateRegistryOpenApiDoc } from "./registry-openapi-definition";

const generators = {
  api: generateOpenApiDoc,
  registry: generateRegistryOpenApiDoc,
} as const;

type DocName = keyof typeof generators;

const args = process.argv.slice(2);

function flagValue(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index !== -1 ? args[index + 1] : undefined;
}

const docName = (flagValue("--doc") ?? "api") as DocName;
const generate = generators[docName];
if (!generate) {
  throw new Error(
    `Unknown --doc '${docName}'. Expected one of: ${Object.keys(generators).join(", ")}.`,
  );
}

const outIndex = args.indexOf("--out");
const defaultOut =
  docName === "registry"
    ? "./openapi/registry.v1.openapi.json"
    : "./openapi/cyrnel.v1.openapi.json";
const outputPaths =
  outIndex !== -1
    ? (() => {
        const rest = args.slice(outIndex + 1);
        const end = rest.findIndex((a) => a.startsWith("--"));
        return end === -1 ? rest : rest.slice(0, end);
      })()
    : [resolve(process.cwd(), defaultOut)];

if (outputPaths.length === 0) {
  throw new Error(
    "Expected at least one path after --out, or omit --out to use the default.",
  );
}

const doc = JSON.stringify(generate(), null, 2);

for (const outputPath of outputPaths) {
  const resolved = resolve(process.cwd(), outputPath);
  mkdirSync(resolve(resolved, ".."), { recursive: true });
  writeFileSync(resolved, doc);
}
