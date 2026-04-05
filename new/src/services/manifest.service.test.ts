import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ManifestService,
  resolveMciDataDir,
} from "@/services/manifest.service";

describe("manifest.service", () => {
  it("resolveMciDataDir() defaults to ~/mci", () => {
    expect(resolveMciDataDir(undefined)).toBe(path.join(homedir(), "mci"));
    expect(resolveMciDataDir("  ")).toBe(path.join(homedir(), "mci"));
  });

  it("resolveMciDataDir() expands ~/ prefix", () => {
    expect(resolveMciDataDir("~/custom-dir")).toBe(
      path.join(homedir(), "custom-dir"),
    );
  });

  it("creates manifests directory when initialized", () => {
    const base = mkdtempSync(path.join(process.cwd(), "manifest-test-"));

    try {
      const dataDir = path.join(base, "data");
      const service = new ManifestService(dataDir);

      expect(service.manifestsDir).toBe(path.join(dataDir, "manifests"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("loads tool schemas from manifest file", async () => {
    const base = mkdtempSync(path.join(process.cwd(), "manifest-test-"));

    try {
      const service = new ManifestService(base);
      const manifestPath = path.join(service.manifestsDir, "svc-1.json");

      writeFileSync(
        manifestPath,
        JSON.stringify({
          tools: [
            {
              name: "tool-1",
              input_schema: {
                type: "object",
                properties: {
                  count: { type: "number" },
                },
              },
              output_schema: {
                type: "string",
              },
            },
          ],
        }),
      );

      const tool = await service.getTool("svc-1", "tool-1");

      expect(tool).toMatchObject({
        name: "tool-1",
        inputSchema: {
          type: "object",
          properties: {
            count: { type: "number" },
          },
        },
        outputSchema: {
          type: "string",
        },
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("supports alternative manifest field names", async () => {
    const base = mkdtempSync(path.join(process.cwd(), "manifest-test-"));

    try {
      const service = new ManifestService(base);
      const manifestPath = path.join(service.manifestsDir, "svc-2.json");

      writeFileSync(
        manifestPath,
        JSON.stringify({
          functions: [
            {
              id: "tool-2",
              inputSchema: {
                type: "object",
              },
              outputSchema: {
                type: "number",
              },
            },
          ],
        }),
      );

      const tool = await service.getTool("svc-2", "tool-2");

      expect(tool.name).toBe("tool-2");
      expect(tool.outputSchema).toEqual({ type: "number" });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
