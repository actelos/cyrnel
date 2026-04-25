import { asc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/db/client";
import { manifests, tools } from "@/db/schema";
import type { ManifestMetadata, ToolDefinition } from "@/models/manifest.model";
import type { AdapterModule } from "@/modules/adapter.module";
import {
  isUniqueConstraintViolation,
  ManifestService,
} from "@/services/manifest.service";

describe("manifest.service unit", () => {
  it("loads tool and metadata through injected loaders", async () => {
    const metadata: ManifestMetadata = { serverUrl: "http://127.0.0.1:8787" };
    const toolDefinition: ToolDefinition = {
      name: "tool-1",
      description: "",
      enabled: true,
      metadata: { requestKind: "rpc.invoke", route: "echo" },
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
    };

    const service = new ManifestService(
      async (serviceName) =>
        serviceName === "svc-1" ? { metadata, enabled: true } : null,
      async (serviceName, toolName) =>
        serviceName === "svc-1" && toolName === "tool-1"
          ? toolDefinition
          : null,
    );

    await expect(service.getTool("svc-1", "tool-1")).resolves.toEqual({
      tool: toolDefinition,
      serviceMetadata: metadata,
      serviceEnabled: true,
    });
  });

  it("returns 404 when manifest is missing", async () => {
    const service = new ManifestService(
      async () => null,
      async () => null,
    );

    await expect(
      service.getTool("missing-service", "tool-1"),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("returns 404 when tool is missing", async () => {
    const service = new ManifestService(
      async () => ({
        metadata: { serverUrl: "http://127.0.0.1:8788" },
        enabled: true,
      }),
      async () => null,
    );

    await expect(
      service.getTool("svc-2", "missing-tool"),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("validates empty inputs before attempting any database-backed lookup", async () => {
    const service = new ManifestService(
      async () => {
        throw new Error("loader should not be called");
      },
      async () => {
        throw new Error("loader should not be called");
      },
    );

    await expect(service.getTool("   ", "tool")).rejects.toMatchObject({
      statusCode: 400,
    });

    await expect(service.getTool("svc", "   ")).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("detects SQLite and Postgres unique-constraint errors", () => {
    expect(
      isUniqueConstraintViolation(
        new Error("UNIQUE constraint failed: manifests.definition_id"),
      ),
    ).toBe(true);

    expect(
      isUniqueConstraintViolation(
        new Error(
          'duplicate key value violates unique constraint "manifests_definition_id_unique"',
        ),
      ),
    ).toBe(true);

    expect(
      isUniqueConstraintViolation({
        code: "SQLITE_CONSTRAINT_UNIQUE",
        message: "driver unique violation",
      }),
    ).toBe(true);
  });

  it("does not mislabel non-unique constraint errors", () => {
    expect(
      isUniqueConstraintViolation(
        new Error("NOT NULL constraint failed: manifests.hash"),
      ),
    ).toBe(false);

    expect(
      isUniqueConstraintViolation(new Error("FOREIGN KEY constraint failed")),
    ).toBe(false);

    expect(
      isUniqueConstraintViolation(new Error("CHECK constraint failed")),
    ).toBe(false);
  });
});

async function resetManifestTables(): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  await db.run(sql`DROP TABLE IF EXISTS tools`);
  await db.run(sql`DROP TABLE IF EXISTS manifests`);
  await db.run(sql`
    CREATE TABLE manifests (
      id text PRIMARY KEY NOT NULL,
      type text NOT NULL,
      source text NOT NULL DEFAULT '',
      description text NOT NULL DEFAULT '',
      hash text NOT NULL,
      enabled integer NOT NULL DEFAULT 1,
      metadata text NOT NULL
    )
  `);
  await db.run(sql`CREATE INDEX manifests_type_idx ON manifests (type)`);
  await db.run(sql`
    CREATE TABLE tools (
      service_id text NOT NULL,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      enabled integer NOT NULL DEFAULT 1,
      input_schema text NOT NULL,
      output_schema text NOT NULL,
      metadata text NOT NULL,
      PRIMARY KEY(service_id, name),
      FOREIGN KEY (service_id) REFERENCES manifests(id) ON UPDATE no action ON DELETE cascade
    )
  `);
  await db.run(sql`CREATE INDEX tools_name_idx ON tools (name)`);
  await db.run(sql`PRAGMA foreign_keys = ON`);
}

describe("manifest.service update semantics", () => {
  beforeEach(async () => {
    await resetManifestTables();
  });

  it("preserves existing tool enabled state and defaults new tools to enabled", async () => {
    const serviceName = "svc-preserve-enabled";
    const sourceUrl = "https://registry.example.com/svc-preserve-enabled.json";

    await db.insert(manifests).values({
      id: serviceName,
      type: "foo",
      source: sourceUrl,
      description: "",
      hash: "hash-old",
      enabled: true,
      metadata: { serverUrl: "http://127.0.0.1:9100" },
    });

    await db.insert(tools).values([
      {
        serviceName,
        name: "existing-disabled",
        description: "",
        enabled: false,
        metadata: { route: "invoke/existing-disabled" },
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
      {
        serviceName,
        name: "existing-enabled",
        description: "",
        enabled: true,
        metadata: { route: "invoke/existing-enabled" },
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
    ]);

    const updatedManifest = {
      name: serviceName,
      description: "",
      enabled: true,
      metadata: {
        serverUrl: "http://127.0.0.1:9200",
      },
      tools: [
        {
          name: "existing-disabled",
          description: "",
          enabled: true,
          metadata: { route: "invoke/existing-disabled-v2" },
          inputSchema: { type: "object" },
          outputSchema: { type: "string" },
        },
        {
          name: "existing-enabled",
          description: "",
          enabled: false,
          metadata: { route: "invoke/existing-enabled-v2" },
          inputSchema: { type: "object" },
          outputSchema: { type: "string" },
        },
        {
          name: "new-tool",
          description: "",
          enabled: false,
          metadata: { route: "invoke/new-tool" },
          inputSchema: { type: "object" },
          outputSchema: { type: "string" },
        },
      ],
    };

    const updatedManifestContent = JSON.stringify(updatedManifest);

    const fetchImpl = vi.fn(
      async () =>
        new Response(updatedManifestContent, {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }),
    );

    const adapter = {
      register: vi.fn(async (content: string) => JSON.parse(content)),
    } as unknown as AdapterModule;

    const service = new ManifestService(
      undefined,
      undefined,
      adapter,
      fetchImpl,
    );

    await expect(service.updateService(serviceName)).resolves.toBe(true);

    const updatedTools = await db
      .select({ name: tools.name, enabled: tools.enabled })
      .from(tools)
      .where(eq(tools.serviceName, serviceName))
      .orderBy(asc(tools.name));

    expect(updatedTools).toEqual([
      { name: "existing-disabled", enabled: false },
      { name: "existing-enabled", enabled: true },
      { name: "new-tool", enabled: true },
    ]);

    expect(fetchImpl).toHaveBeenCalledWith(
      sourceUrl,
      expect.objectContaining({ method: "GET" }),
    );
  });
});
