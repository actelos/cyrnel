import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db/client";
import { AdapterPoolService } from "@/services/adapter-pool.service";

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
      sql`INSERT INTO services (id, config_schema) VALUES ('svc-defaults', ${JSON.stringify(schema)})`,
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
      sql`INSERT INTO services (id, config_schema) VALUES ('svc-invalid', ${JSON.stringify(schema)})`,
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
});

async function resetServiceConfigTables(): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  await db.run(sql`DROP TABLE IF EXISTS configurations`);
  await db.run(sql`DROP TABLE IF EXISTS services`);
  await db.run(sql`
    CREATE TABLE services (
      id text PRIMARY KEY NOT NULL,
      config_schema text NOT NULL
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
  await db.run(sql`PRAGMA foreign_keys = ON`);
}
