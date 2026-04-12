import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db/client";
import { definitions } from "@/db/schema";
import { DefinitionService } from "@/services/definition.service";
import { computeContentHash } from "@/utils/hash.util";

async function resetTables(): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  await db.run(sql`DROP TABLE IF EXISTS tools`);
  await db.run(sql`DROP TABLE IF EXISTS manifests`);
  await db.run(sql`DROP TABLE IF EXISTS definitions`);
  await db.run(sql`
    CREATE TABLE definitions (
      id text PRIMARY KEY NOT NULL,
      type text NOT NULL,
      content blob NOT NULL,
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

describe("definition.service integration", () => {
  beforeEach(async () => {
    await resetTables();
  });

  it("creates definition record with content blob", async () => {
    const service = new DefinitionService();

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
        content: definitions.content,
        hash: definitions.hash,
      })
      .from(definitions);

    expect(definitionRows).toHaveLength(1);
    expect(definitionRows[0]).toMatchObject({
      id: created.id,
      type: "foo",
      hash: created.hash,
    });
    expect(definitionRows[0].content.toString("utf8")).toBe(content);

    await expect(service.listDefinitions()).resolves.toEqual([created]);
    await expect(service.getDefinition(created.id)).resolves.toEqual(created);
  });

  it("deletes definition", async () => {
    const service = new DefinitionService();

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

    const created = await service.createDefinition("foo", content);

    await service.deleteDefinition(created.id);

    await expect(service.listDefinitions()).resolves.toEqual([]);
  });

  it("throws 400 for unsupported definition type", async () => {
    const service = new DefinitionService();

    await expect(
      service.createDefinition(
        "bar",
        '{"name":"svc","metadata":{},"tools":[]}',
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("accepts non-JSON definition content", async () => {
    const service = new DefinitionService();

    await expect(
      service.createDefinition("foo", "not-json"),
    ).resolves.toMatchObject({
      id: expect.any(String),
      type: "foo",
      hash: computeContentHash("not-json"),
    });
    await expect(db.select().from(definitions)).resolves.toHaveLength(1);
  });
});
