import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db/client";
import { definitions } from "@/db/schema";
import { computeContentHash } from "@/utils/hash.util";
import { DefinitionService } from "@/services/definition.service";

async function resetTables(): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  await db.run(sql`DROP TABLE IF EXISTS tools`);
  await db.run(sql`DROP TABLE IF EXISTS manifests`);
  await db.run(sql`DROP TABLE IF EXISTS definitions`);
  await db.run(sql`
    CREATE TABLE definitions (
      id text PRIMARY KEY NOT NULL,
      type text NOT NULL,
      path text NOT NULL,
      hash text NOT NULL
    )
  `);
  await db.run(sql`
    CREATE TABLE manifests (
      id text PRIMARY KEY NOT NULL,
      definition_id text UNIQUE,
      hash text NOT NULL,
      metadata text NOT NULL,
      FOREIGN KEY (definition_id) REFERENCES definitions(id) ON UPDATE no action ON DELETE cascade
    )
  `);
  await db.run(sql`
    CREATE TABLE tools (
      service_id text NOT NULL,
      name text NOT NULL,
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

describe("definition.service", () => {
  beforeEach(async () => {
    await resetTables();
  });

  it("creates definition file and definition record", async () => {
    const service = new DefinitionService();
    const directory = await mkdtemp(path.join(tmpdir(), "mci-def-"));
    process.env.MCI_DATA_DIR = directory;

    const content = JSON.stringify({
      name: "svc-def-1",
      metadata: {
        serverUrl: "http://127.0.0.1:9876",
      },
      tools: [
        {
          name: "echo",
          metadata: {},
          inputSchema: {
            type: "object",
          },
          outputSchema: {
            type: "string",
          },
        },
      ],
    });

    try {
      const created = await service.createDefinition("foo", content);

      expect(created).toMatchObject({
        id: expect.any(String),
        type: "foo",
        hash: computeContentHash(content),
      });

      const definitionRows = await db
        .select({
          id: definitions.id,
          type: definitions.type,
          path: definitions.path,
          hash: definitions.hash,
        })
        .from(definitions);

      expect(definitionRows).toHaveLength(1);
      expect(definitionRows[0]).toMatchObject({
        id: created.id,
        type: "foo",
        hash: created.hash,
      });

      const persistedFile = await readFile(definitionRows[0].path, "utf8");
      expect(persistedFile).toBe(content);

      await expect(service.listDefinitions()).resolves.toEqual([created]);
      await expect(service.getDefinition(created.id)).resolves.toEqual(created);
    } finally {
      await rm(directory, { recursive: true, force: true });
      delete process.env.MCI_DATA_DIR;
    }
  });

  it("deletes definition and its file", async () => {
    const service = new DefinitionService();
    const directory = await mkdtemp(path.join(tmpdir(), "mci-def-"));
    process.env.MCI_DATA_DIR = directory;

    const content = JSON.stringify({
      name: "svc-def-delete",
      metadata: {
        serverUrl: "http://127.0.0.1:9888",
      },
      tools: [
        {
          name: "echo",
          metadata: {},
          inputSchema: {
            type: "object",
          },
          outputSchema: {
            type: "string",
          },
        },
      ],
    });

    try {
      const created = await service.createDefinition("foo", content);
      const existing = await db
        .select({ path: definitions.path })
        .from(definitions)
        .limit(1);

      expect(existing).toHaveLength(1);

      await service.deleteDefinition(created.id);

      await expect(service.listDefinitions()).resolves.toEqual([]);

      await expect(readFile(existing[0].path, "utf8")).rejects.toBeTruthy();
    } finally {
      await rm(directory, { recursive: true, force: true });
      delete process.env.MCI_DATA_DIR;
    }
  });

  it("throws 400 for unsupported definition type", async () => {
    const service = new DefinitionService();

    await expect(
      service.createDefinition("bar", '{"name":"svc","metadata":{},"tools":[]}'),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("accepts non-JSON definition content", async () => {
    const service = new DefinitionService();

    await expect(service.createDefinition("foo", "not-json")).resolves.toMatchObject({
      id: expect.any(String),
      type: "foo",
      hash: computeContentHash("not-json"),
    });
    await expect(db.select().from(definitions)).resolves.toHaveLength(1);
  });
});
