import path from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";

import { HttpError } from "@/models/error.model";
import type { JSONSchema, ManifestTool } from "@/models/manifest.model";

const DEFAULT_DATA_DIR = "~/mci";

export class ManifestService {
  readonly dataDir: string;
  readonly manifestsDir: string;

  constructor(dataDir = resolveMciDataDir(process.env.MCI_DATA_DIR)) {
    this.dataDir = dataDir;
    this.manifestsDir = path.join(this.dataDir, "manifests");
    this.ensureManifestsDirectory();
  }

  async getTool(serviceId: string, toolId: string): Promise<ManifestTool> {
    const normalizedServiceId = normalizeServiceId(serviceId);
    const normalizedToolId = toolId.trim();

    if (!normalizedToolId) {
      throw new HttpError(400, "Tool id must not be empty.");
    }

    const manifestPath = path.join(
      this.manifestsDir,
      `${normalizedServiceId}.json`,
    );

    let rawManifest: string;
    try {
      rawManifest = await readFile(manifestPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new HttpError(
          404,
          `Manifest not found for service '${normalizedServiceId}'.`,
        );
      }

      throw new HttpError(
        500,
        `Failed to read manifest for service '${normalizedServiceId}'.`,
      );
    }

    let parsedManifest: unknown;
    try {
      parsedManifest = JSON.parse(rawManifest);
    } catch {
      throw new HttpError(
        400,
        `Manifest '${normalizedServiceId}.json' contains invalid JSON.`,
      );
    }

    const tools = normalizeManifest(parsedManifest, normalizedServiceId);
    const tool = tools.find((item) => item.name === normalizedToolId);

    if (!tool) {
      throw new HttpError(
        404,
        `Tool '${normalizedToolId}' not found in manifest for service '${normalizedServiceId}'.`,
      );
    }

    return tool;
  }

  private ensureManifestsDirectory(): void {
    if (existsSync(this.manifestsDir)) {
      return;
    }

    mkdirSync(this.manifestsDir, { recursive: true });
  }
}

export function resolveMciDataDir(rawValue: string | undefined): string {
  const value = rawValue?.trim();
  const chosen = value && value.length > 0 ? value : DEFAULT_DATA_DIR;

  if (chosen === "~") {
    return homedir();
  }

  if (chosen.startsWith("~/")) {
    return path.join(homedir(), chosen.slice(2));
  }

  return chosen;
}

function normalizeServiceId(serviceId: string): string {
  const normalized = serviceId.trim();

  if (!normalized) {
    throw new HttpError(400, "Service id must not be empty.");
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) {
    throw new HttpError(
      400,
      "Service id may only contain letters, numbers, dot, underscore, and hyphen.",
    );
  }

  return normalized;
}

function normalizeManifest(
  manifest: unknown,
  serviceId: string,
): ManifestTool[] {
  if (!isRecord(manifest)) {
    throw new HttpError(
      400,
      `Manifest for service '${serviceId}' must be a JSON object.`,
    );
  }

  const toolsValue = findToolsCollection(manifest);

  if (!Array.isArray(toolsValue)) {
    throw new HttpError(
      400,
      `Manifest for service '${serviceId}' must contain a tools array.`,
    );
  }

  const tools = toolsValue
    .map((tool, index) => normalizeTool(tool, serviceId, index))
    .filter((tool): tool is ManifestTool => tool !== null);

  if (tools.length === 0) {
    throw new HttpError(
      400,
      `Manifest for service '${serviceId}' has no valid tools.`,
    );
  }

  return tools;
}

function findToolsCollection(manifest: Record<string, unknown>): unknown {
  const preferredKeys = ["tools", "tool", "functions", "capabilities"];

  for (const key of preferredKeys) {
    if (Array.isArray(manifest[key])) {
      return manifest[key];
    }
  }

  for (const value of Object.values(manifest)) {
    if (Array.isArray(value)) {
      return value;
    }
  }

  return undefined;
}

function normalizeTool(
  value: unknown,
  serviceId: string,
  index: number,
): ManifestTool | null {
  if (!isRecord(value)) {
    return null;
  }

  const name = extractToolName(value);
  const inputSchema = extractSchema(value, true);
  const outputSchema = extractSchema(value, false);

  if (!name || inputSchema === undefined || outputSchema === undefined) {
    throw new HttpError(
      400,
      `Invalid tool definition at index ${index} in manifest for service '${serviceId}'.`,
    );
  }

  return {
    name,
    inputSchema,
    outputSchema,
  };
}

function extractToolName(tool: Record<string, unknown>): string | null {
  const preferredKeys = ["name", "id", "tool", "toolId"];

  for (const key of preferredKeys) {
    const candidate = tool[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  for (const candidate of Object.values(tool)) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function extractSchema(
  tool: Record<string, unknown>,
  input: boolean,
): JSONSchema | undefined {
  const preferredInputKeys = [
    "input_schema",
    "inputSchema",
    "parameters",
    "paramsSchema",
  ];
  const preferredOutputKeys = [
    "output_schema",
    "outputSchema",
    "response_schema",
    "resultSchema",
  ];

  const preferredKeys = input ? preferredInputKeys : preferredOutputKeys;

  for (const key of preferredKeys) {
    const candidate = tool[key];
    if (isSchema(candidate)) {
      return candidate;
    }
  }

  for (const [key, candidate] of Object.entries(tool)) {
    if (!isSchema(candidate)) {
      continue;
    }

    const lower = key.toLowerCase();
    if (input && lower.includes("input") && lower.includes("schema")) {
      return candidate;
    }

    if (!input && lower.includes("output") && lower.includes("schema")) {
      return candidate;
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSchema(value: unknown): value is JSONSchema {
  return isRecord(value);
}
