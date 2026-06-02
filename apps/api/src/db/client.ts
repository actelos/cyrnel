import { mkdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import * as schema from "@/db/schema";

function resolveDatabaseUrl(): string {
  if (process.env.MCI_DB_URL) return process.env.MCI_DB_URL;
  if (process.env.NODE_ENV === "test" || process.env.VITEST)
    return "file::memory:?cache=shared";

  const dataDir = process.env.MCI_DATA_DIR ?? ".";
  mkdirSync(dataDir, { recursive: true });
  return `file:${path.join(dataDir, "mci.db")}`;
}

export { schema };
export const db = drizzle(createClient({ url: resolveDatabaseUrl() }), {
  schema,
});
