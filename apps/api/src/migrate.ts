import "dotenv/config";

import path from "node:path";

import { migrate } from "drizzle-orm/libsql/migrator";

import { db } from "@/db/client";
import { initLogger, logger } from "@/infra/logging";

const migrationsFolder = path.join(import.meta.dirname, "..", "drizzle");
initLogger();
await migrate(db, { migrationsFolder });
logger.info(
  { event: "migrations-applied", migrationsFolder },
  "Database migrations applied",
);
