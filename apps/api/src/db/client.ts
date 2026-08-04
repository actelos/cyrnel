import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import * as schema from "@/db/schema";

let testDbPath: string | null = null;

function resolveDatabaseUrl(): string {
  if (process.env.CYRNEL_DB_URL) return process.env.CYRNEL_DB_URL;
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    if (!testDbPath) {
      testDbPath = path.join(
        tmpdir(),
        `cyrnel-test-${process.pid}-${Date.now()}.db`,
      );
    }
    return `file:${testDbPath}`;
  }

  const dataDir = process.env.CYRNEL_DATA_DIR ?? ".";
  mkdirSync(dataDir, { recursive: true });
  return `file:${path.join(dataDir, "data.db")}`;
}

export { resolveDatabaseUrl, schema };
export const db = drizzle(createClient({ url: resolveDatabaseUrl() }), {
  schema,
});
