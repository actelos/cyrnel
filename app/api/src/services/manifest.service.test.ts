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
        new Error("UNIQUE constraint failed: services.definition_id"),
      ),
    ).toBe(true);

    expect(
      isUniqueConstraintViolation(
        new Error(
          'duplicate key value violates unique constraint "services_definition_id_unique"',
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
        new Error("NOT NULL constraint failed: services.hash"),
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
  await db.run(sql`DROP TABLE IF EXISTS configurations`);
  await db.run(sql`DROP TABLE IF EXISTS services`);
  await db.run(sql`
    CREATE TABLE services (
      id text PRIMARY KEY NOT NULL,
      type text NOT NULL,
      source text NOT NULL DEFAULT '',
      description text NOT NULL DEFAULT '',
      hash text NOT NULL,
      enabled integer NOT NULL DEFAULT 1,
      metadata text NOT NULL,
      config_schema text NOT NULL
    )
  `);
  await db.run(sql`CREATE INDEX services_type_idx ON services (type)`);
  await db.run(sql`
    CREATE TABLE configurations (
      service_name text PRIMARY KEY NOT NULL,
      config text NOT NULL DEFAULT '{}',
      updated_at integer NOT NULL,
      FOREIGN KEY (service_name) REFERENCES services(id) ON UPDATE no action ON DELETE cascade
    )
  `);
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
      FOREIGN KEY (service_id) REFERENCES services(id) ON UPDATE no action ON DELETE cascade
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
      configSchema: { type: "null" },
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
      configSchema: { type: "null" },
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

describe("manifest.service configuration", () => {
  beforeEach(async () => {
    await resetManifestTables();
  });

  it("returns {} when no config exists", async () => {
    const serviceName = "svc-config-missing";

    await db.insert(manifests).values({
      id: serviceName,
      type: "foo",
      source: "https://registry.example.com/svc.json",
      description: "",
      hash: "hash",
      enabled: true,
      metadata: { serverUrl: "http://127.0.0.1:9999" },
      configSchema: { type: "null" },
    });

    const service = new ManifestService();

    await expect(service.getServiceConfig(serviceName)).resolves.toEqual({});
  });

  it("applies JSON Patch against {} baseline when missing", async () => {
    const serviceName = "svc-config-patch";
    const schema = {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      additionalProperties: false,
    };

    await db.insert(manifests).values({
      id: serviceName,
      type: "foo",
      source: "https://registry.example.com/svc.json",
      description: "",
      hash: "hash",
      enabled: true,
      metadata: { serverUrl: "http://127.0.0.1:9999" },
      configSchema: schema,
    });

    const service = new ManifestService();

    const updated = await service.patchServiceConfig(serviceName, [
      { op: "add", path: "/enabled", value: true },
    ]);

    expect(updated).toEqual({ enabled: true });

    const stored = await db.run(
      sql`SELECT config FROM configurations WHERE service_name = ${serviceName} LIMIT 1`,
    );
    expect(stored.rows).toHaveLength(1);
    expect(JSON.parse(String(stored.rows[0]?.config ?? "{}"))).toEqual({
      enabled: true,
    });
  });

  it("rejects config updates that fail schema validation", async () => {
    const serviceName = "svc-config-invalid";
    const schema = {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      additionalProperties: false,
    };

    await db.insert(manifests).values({
      id: serviceName,
      type: "foo",
      source: "https://registry.example.com/svc.json",
      description: "",
      hash: "hash",
      enabled: true,
      metadata: { serverUrl: "http://127.0.0.1:9999" },
      configSchema: schema,
    });

    const service = new ManifestService();

    await expect(
      service.patchServiceConfig(serviceName, [
        { op: "add", path: "/enabled", value: "yes" },
      ]),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("loads config schema from persisted manifests table", async () => {
    const serviceName = "svc-config-schema";
    const schema = { type: "object" };

    await db.insert(manifests).values({
      id: serviceName,
      type: "foo",
      source: "https://registry.example.com/svc.json",
      description: "",
      hash: "hash",
      enabled: true,
      metadata: { serverUrl: "http://127.0.0.1:9999" },
      configSchema: schema,
    });

    const service = new ManifestService();

    await expect(service.getServiceConfigSchema(serviceName)).resolves.toEqual(
      schema,
    );
  });

  it("applies schema defaults when patching configuration", async () => {
    const serviceName = "svc-config-defaults";
    const schema = {
      type: "object",
      properties: {
        enabled: { type: "boolean", default: true },
        mode: { type: "string", default: "fast" },
      },
      additionalProperties: false,
    };

    await db.insert(manifests).values({
      id: serviceName,
      type: "foo",
      source: "https://registry.example.com/svc.json",
      description: "",
      hash: "hash",
      enabled: true,
      metadata: { serverUrl: "http://127.0.0.1:9999" },
      configSchema: schema,
    });

    const service = new ManifestService();

    const updated = await service.patchServiceConfig(serviceName, []);

    expect(updated).toEqual({ enabled: true, mode: "fast" });

    const stored = await db.run(
      sql`SELECT config FROM configurations WHERE service_name = ${serviceName} LIMIT 1`,
    );
    expect(stored.rows).toHaveLength(1);
    expect(JSON.parse(String(stored.rows[0]?.config ?? "{}"))).toEqual({
      enabled: true,
      mode: "fast",
    });
  });

  it("rejects enabling when stored config fails schema validation", async () => {
    const serviceName = "svc-config-enable-invalid";
    const schema = {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      additionalProperties: false,
    };

    await db.insert(manifests).values({
      id: serviceName,
      type: "foo",
      source: "https://registry.example.com/svc.json",
      description: "",
      hash: "hash",
      enabled: false,
      metadata: { serverUrl: "http://127.0.0.1:9999" },
      configSchema: schema,
    });

    await db.run(
      sql`INSERT INTO configurations (service_name, config, updated_at) VALUES (${serviceName}, ${JSON.stringify({ enabled: "yes" })}, ${Date.now()})`,
    );

    const service = new ManifestService();

    await expect(
      service.setServiceEnabled(serviceName, true),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
