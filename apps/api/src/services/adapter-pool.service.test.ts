import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db/client";
import { AdapterPoolService } from "@/services/adapter-pool.service";
import { encryptSecrets } from "@/utils/secrets.util";

describe("AdapterPoolService", () => {
  beforeEach(async () => {
    await resetServiceConfigTables();
  });

  it("allocate() returns the same adapter instance", () => {
    const pool = new AdapterPoolService();

    const first = pool.allocate();
    const second = pool.allocate();

    expect(first).toBe(second);

    pool.release(first);
    pool.release(second);
  });

  it("release() is a no-op for unknown adapters", () => {
    const pool = new AdapterPoolService();

    const adapter = pool.allocate();
    pool.release(adapter);

    pool.release(adapter);
  });

  it("shutdown() prevents further allocation", () => {
    const pool = new AdapterPoolService();

    const adapter = pool.allocate();
    pool.release(adapter);
    pool.shutdown();

    expect(() => pool.allocate()).toThrow("Adapter pool has been shut down.");
  });

  it("hydrates defaults from config schema", async () => {
    const schema = {
      type: "object",
      properties: {
        enabled: { type: "boolean", default: true },
        mode: { type: "string", default: "fast" },
      },
      additionalProperties: false,
    };

    await db.run(
      sql`INSERT INTO services (id, config_schema, secrets_schema) VALUES ('svc-defaults', ${JSON.stringify(schema)}, ${JSON.stringify({ type: "object" })})`,
    );

    const pool = new AdapterPoolService();

    await (
      pool as unknown as { stageFromDatabase(): Promise<boolean> }
    ).stageFromDatabase();

    const adapter = pool.allocate();

    expect(adapter.getServiceConfig("svc-defaults")).toEqual({
      enabled: true,
      mode: "fast",
    });

    pool.release(adapter);
  });

  it("rejects staging when stored config fails schema validation", async () => {
    const schema = {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      additionalProperties: false,
    };

    await db.run(
      sql`INSERT INTO services (id, config_schema, secrets_schema) VALUES ('svc-invalid', ${JSON.stringify(schema)}, ${JSON.stringify({ type: "object" })})`,
    );

    await db.run(
      sql`INSERT INTO configurations (service_name, config, updated_at) VALUES ('svc-invalid', ${JSON.stringify({ enabled: "nope" })}, ${Date.now()})`,
    );

    const pool = new AdapterPoolService();

    await expect(
      (
        pool as unknown as { stageFromDatabase(): Promise<boolean> }
      ).stageFromDatabase(),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("hydrates decrypted secrets with schema defaults", async () => {
    const secretsSchema = {
      type: "object",
      properties: {
        token: { type: "string" },
        region: { type: "string", default: "us-east-1" },
      },
      additionalProperties: false,
    };

    await db.run(
      sql`INSERT INTO services (id, config_schema, secrets_schema) VALUES ('svc-secrets', ${JSON.stringify({ type: "null" })}, ${JSON.stringify(secretsSchema)})`,
    );

    const encrypted = encryptSecrets({ token: "secret-token" });

    await db.run(
      sql`INSERT INTO secrets (service_name, payload, updated_at) VALUES ('svc-secrets', ${JSON.stringify(encrypted)}, ${Date.now()})`,
    );

    const pool = new AdapterPoolService();

    await (
      pool as unknown as { stageFromDatabase(): Promise<boolean> }
    ).stageFromDatabase();

    const adapter = pool.allocate();

    expect(adapter.getServiceSecrets("svc-secrets")).toEqual({
      token: "secret-token",
      region: "us-east-1",
    });

    pool.release(adapter);
  });
});

async function resetServiceConfigTables(): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  await db.run(sql`DROP TABLE IF EXISTS configurations`);
  await db.run(sql`DROP TABLE IF EXISTS secrets`);
  await db.run(sql`DROP TABLE IF EXISTS services`);
  await db.run(sql`
    CREATE TABLE services (
      id text PRIMARY KEY NOT NULL,
      config_schema text NOT NULL,
      secrets_schema text NOT NULL
    )
  `);
  await db.run(sql`
    CREATE TABLE configurations (
      service_name text PRIMARY KEY NOT NULL,
      config text NOT NULL DEFAULT '{}',
      updated_at integer NOT NULL,
      FOREIGN KEY (service_name) REFERENCES services(id) ON UPDATE no action ON DELETE cascade
    )
  `);
  await db.run(sql`
    CREATE TABLE secrets (
      service_name text PRIMARY KEY NOT NULL,
      payload text NOT NULL,
      updated_at integer NOT NULL,
      FOREIGN KEY (service_name) REFERENCES services(id) ON UPDATE no action ON DELETE cascade
    )
  `);
  await db.run(sql`PRAGMA foreign_keys = ON`);
}
