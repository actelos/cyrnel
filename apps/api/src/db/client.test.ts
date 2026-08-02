import { afterEach, describe, expect, it, vi } from "vitest";

describe("db client", () => {
  const originalDbUrl = process.env.CYRNEL_DB_URL;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    vi.resetModules();

    if (originalDbUrl === undefined) {
      delete process.env.CYRNEL_DB_URL;
    } else {
      process.env.CYRNEL_DB_URL = originalDbUrl;
    }

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("uses CYRNEL_DB_URL when set", async () => {
    process.env.CYRNEL_DB_URL = "file::memory:?cache=shared";
    process.env.NODE_ENV = "production";

    const { db } = await import("@/db/client");

    const result = await db.run("SELECT 1 AS one");

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({ one: 1 });
  });

  it("uses an in-memory database in test environment", async () => {
    delete process.env.CYRNEL_DB_URL;
    process.env.NODE_ENV = "test";

    const { db } = await import("@/db/client");

    const result = await db.run("SELECT 1 AS one");

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({ one: 1 });
  });

  it("exports the schema", async () => {
    process.env.NODE_ENV = "test";

    const { schema } = await import("@/db/client");

    expect(schema.services).toBeDefined();
    expect(schema.processes).toBeDefined();
    expect(schema.modules).toBeDefined();
  });
});
