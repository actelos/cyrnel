import path from "node:path";
import { mkdirSync } from "node:fs";

import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";

import * as schema from "@/db/schema";

const isTestEnvironment =
  process.env.NODE_ENV === "test" || process.env.VITEST !== undefined;

function resolveDatabaseUrl(): string {
  if (process.env.MCI_DB_URL) {
    return process.env.MCI_DB_URL;
  }

  if (isTestEnvironment) {
    return "file::memory:?cache=shared";
  }

  const dataDir = process.env.MCI_DATA_DIR || ".";
  const dbPath = path.join(dataDir, "mci.db");

  mkdirSync(dataDir, { recursive: true });

  return `file:${dbPath}`;
}

const client = createClient({
  url: resolveDatabaseUrl(),
});

export const db = drizzle(client, { schema });
export { schema };
