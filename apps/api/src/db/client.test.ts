import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@libsql/client", () => ({
  createClient: vi.fn(),
}));

describe("db client", () => {
  const originalDbUrl = process.env.CYRNEL_DB_URL;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it("passes CYRNEL_DB_URL to the client factory in production", async () => {
    process.env.CYRNEL_DB_URL = "file:./custom.db";
    process.env.NODE_ENV = "production";

    await import("@/db/client");

    expect(vi.mocked(createClient)).toHaveBeenCalledOnce();
    expect(vi.mocked(createClient)).toHaveBeenCalledWith({
      url: "file:./custom.db",
    });
  });

  it("selects the in-memory database when VITEST masks NODE_ENV", async () => {
    delete process.env.CYRNEL_DB_URL;
    process.env.NODE_ENV = "production";

    await import("@/db/client");

    expect(vi.mocked(createClient)).toHaveBeenCalledWith({
      url: "file::memory:?cache=shared",
    });
  });

  it("exports the schema", async () => {
    delete process.env.CYRNEL_DB_URL;
    process.env.NODE_ENV = "test";

    const { schema } = await import("@/db/client");

    expect(schema.services).toBeDefined();
    expect(schema.processes).toBeDefined();
    expect(schema.modules).toBeDefined();
  });
});
