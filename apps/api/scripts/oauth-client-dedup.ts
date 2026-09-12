import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import {
  moduleCredentials,
  oauthClients,
  registryCredentials,
  serviceCredentials,
} from "../src/db/schema";
import { logger } from "../src/infra/logging";
import { compareSecretEquality } from "../src/utils/secrets.util";

async function main() {
  console.log("Starting OAuth client deduplication...");

  const allClients = await db.select().from(oauthClients);
  console.log(`Found ${allClients.length} OAuth client rows`);

  const groups = new Map();
  for (const client of allClients) {
    const key = `${client.clientId}|${client.tokenUrl}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(client);
  }

  console.log(`Grouped into ${groups.size} unique (clientId, tokenUrl) groups`);

  let totalMerged = 0;
  let totalKeptSeparate = 0;

  for (const [key, group] of groups) {
    if (group.length === 1) continue;

    const [clientId, tokenUrl] = key.split("|");
    console.log(
      `\nProcessing group: clientId=${clientId}, tokenUrl=${tokenUrl} (${group.length} rows)`,
    );

    const canonical = group[0];
    const duplicates = [];

    for (let i = 1; i < group.length; i++) {
      const match = compareSecretEquality(
        canonical.clientSecret,
        group[i].clientSecret,
      );

      if (match) {
        duplicates.push(group[i]);
      } else {
        logger.warn(
          {
            event: "oauth-client-secret-mismatch",
            clientId,
            tokenUrl,
            canonicalId: canonical.id,
            otherId: group[i].id,
            message:
              "Secrets differ within (clientId, tokenUrl) group; keeping separate",
          },
          "OAuth client secret mismatch in deduplication",
        );
        totalKeptSeparate++;
      }
    }

    if (duplicates.length === 0) continue;

    const duplicateIds = duplicates.map((d) => d.id);
    console.log(
      `  Merging ${duplicates.length} duplicate(s) into ${canonical.id}`,
    );

    for (const dupId of duplicateIds) {
      const svcRows = await db
        .select({ id: serviceCredentials.id })
        .from(serviceCredentials)
        .where(eq(serviceCredentials.oauthClientId, dupId));
      for (const row of svcRows) {
        await db
          .update(serviceCredentials)
          .set({ oauthClientId: canonical.id })
          .where(eq(serviceCredentials.id, row.id));
        console.log(
          `  Updated service credential ${row.id} -> ${canonical.id}`,
        );
      }
      const modRows = await db
        .select({ id: moduleCredentials.id })
        .from(moduleCredentials)
        .where(eq(moduleCredentials.oauthClientId, dupId));
      for (const row of modRows) {
        await db
          .update(moduleCredentials)
          .set({ oauthClientId: canonical.id })
          .where(eq(moduleCredentials.id, row.id));
        console.log(`  Updated module credential ${row.id} -> ${canonical.id}`);
      }
      const regRows = await db
        .select({ id: registryCredentials.id })
        .from(registryCredentials)
        .where(eq(registryCredentials.oauthClientId, dupId));
      for (const row of regRows) {
        await db
          .update(registryCredentials)
          .set({ oauthClientId: canonical.id })
          .where(eq(registryCredentials.id, row.id));
        console.log(
          `  Updated registry credential ${row.id} -> ${canonical.id}`,
        );
      }
    }

    for (const dup of duplicates) {
      await db.delete(oauthClients).where(eq(oauthClients.id, dup.id));
      console.log(`  Deleted duplicate oauth_client ${dup.id}`);
      totalMerged++;
    }
  }

  console.log(
    `\nDone. Merged: ${totalMerged}, Kept separate (secret mismatch): ${totalKeptSeparate}`,
  );
}

main()
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$client.close();
  });
