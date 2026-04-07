import "dotenv/config";

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./src/db/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.MCI_DATA_DIR ?? "file:./local.db",
  },
  strict: true,
  verbose: true,
});
