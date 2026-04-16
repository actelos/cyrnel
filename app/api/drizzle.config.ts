import "dotenv/config";
import path from "node:path";

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./src/db/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: `file:${path.join(process.env.MCI_DATA_DIR ?? ".", "mci.db")}`,
  },
  strict: true,
  verbose: true,
});
