import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import * as schema from "@/db/schema";

const databaseUrl = process.env.DATABASE_URL ?? "file:./local.db";
const client = createClient({ url: databaseUrl });

export const db = drizzle(client, { schema });
export { schema };
