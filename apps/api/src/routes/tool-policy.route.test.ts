import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.CYRNEL_DB_URL = `file:${path.join(os.tmpdir(), `cyrnel-http-${process.pid}.db`)}`;
process.env.CYRNEL_SECRETS_KEY = crypto.randomBytes(32).toString("base64");

const { db } = await import("@/db/client");
const { App } = await import("@/app");

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../drizzle");

async function applyMigrations(): Promise<void> {
  const entries = (await fs.readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of entries) {
    const file = await fs.readFile(path.join(MIGRATIONS_DIR, name), "utf8");
    for (const stmt of file
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)) {
      await db.run(sql.raw(stmt));
    }
  }
}

describe("tool-policies HTTP wiring", () => {
  let request: ReturnType<typeof supertest>;

  beforeAll(async () => {
    await applyMigrations();
    const app = new App();
    request = supertest(app.express);
    await db.run(
      sql`INSERT INTO modules (id, name, type, description, enabled, missing)
          VALUES ('openapi', 'openapi', 'adapter', '', 1, 0)`,
    );
    await db.run(
      sql`INSERT INTO services (id, name, description, hash, source, adapter, enabled, config_schema, secrets_schema, adapter_domain)
          VALUES ('github', 'github', '', 'h', '', 'openapi', 1, '{}', '{}', '{}')`,
    );
    for (const toolId of ["search", "delete"]) {
      await db.run(
        sql`INSERT INTO tools (service_id, id, name, description, enabled, input_schema, output_schema, adapter_domain)
            VALUES ('github', ${toolId}, ${toolId}, '', 1, '{}', '{}', '{}')`,
      );
    }
  });

  afterAll(async () => {
    await db.run(sql.raw("PRAGMA foreign_keys = OFF"));
    for (const name of ["tool_policy_rules", "tools", "services", "modules"]) {
      await db.run(sql.raw(`DELETE FROM ${name}`));
    }
    await db.run(sql.raw("PRAGMA foreign_keys = ON"));
  });

  it("full rule lifecycle over HTTP", async () => {
    const broad = (
      await request
        .post("/tool-policies")
        .send({ servicePattern: "github", toolPattern: "*", decision: "allow" })
        .expect(201)
    ).body as { id: string; position: number };
    expect(broad.position).toBe(0);

    const narrow = (
      await request
        .post("/tool-policies")
        .send({
          servicePattern: "github",
          toolPattern: "delete",
          decision: "block",
        })
        .expect(201)
    ).body as { id: string; position: number };
    expect(narrow.position).toBe(1);

    const listed = (await request.get("/tool-policies").expect(200)).body as {
      id: string;
    }[];
    expect(listed.map((r) => r.id)).toEqual([broad.id, narrow.id]);

    // Broad rule first: delete is allowed (shadowed).
    const tools = (
      await request.get("/tools").query({ serviceId: "github" }).expect(200)
    ).body as {
      items: {
        id: string;
        policy: {
          decision: string;
          source: { type: string; ruleId?: string; position?: number };
        };
      }[];
    };
    expect(tools.items.find((t) => t.id === "delete")?.policy).toMatchObject({
      decision: "allow",
      source: { type: "rule" },
    });

    const allowed = (
      await request
        .get("/tools")
        .query({ serviceId: "github", decision: "allow" })
        .expect(200)
    ).body as { items: unknown[] };
    expect(allowed.items).toHaveLength(2);

    const preview = (
      await request
        .get("/tool-policies/preview")
        .query({ servicePattern: "github", toolPattern: "*" })
        .expect(200)
    ).body as { matchCount: number };
    expect(preview.matchCount).toBe(2);

    // Exact rule matches only its own tool; broad rule matches both.
    const affected = (
      await request
        .get(`/tool-policies/${narrow.id}/affected-tools`)
        .expect(200)
    ).body as { items: { toolId: string }[] };
    expect(affected.items.map((t) => t.toolId)).toEqual(["delete"]);
    const affectedBroad = (
      await request.get(`/tool-policies/${broad.id}/affected-tools`).expect(200)
    ).body as { items: { toolId: string }[] };
    expect(affectedBroad.items.map((t) => t.toolId).sort()).toEqual([
      "delete",
      "search",
    ]);

    // Reorder: narrow first → delete becomes blocked.
    await request
      .put("/tool-policies/order")
      .send({ orderedIds: [narrow.id, broad.id] })
      .expect(200);
    const after = (
      await request.get("/tools").query({ serviceId: "github" }).expect(200)
    ).body as {
      items: { id: string; policy: { decision: string } }[];
    };
    expect(after.items.find((t) => t.id === "delete")?.policy.decision).toBe(
      "block",
    );

    await request
      .patch(`/tool-policies/${narrow.id}`)
      .send({ decision: "ask" })
      .expect(200);

    await request.delete(`/tool-policies/${narrow.id}`).expect(204);
    const remaining = (await request.get("/tool-policies").expect(200))
      .body as { id: string; position: number }[];
    expect(remaining).toMatchObject([{ id: broad.id, position: 0 }]);
  });

  it("old per-tool policy endpoint is gone", async () => {
    await request
      .put("/tools/github/search/policy")
      .send({ decision: "allow" })
      .expect(404);
  });

  it("rejects invalid patterns and bad reorder payloads", async () => {
    await request
      .post("/tool-policies")
      .send({ servicePattern: "a*b", toolPattern: "*", decision: "allow" })
      .expect(400);
    await request
      .put("/tool-policies/order")
      .send({ orderedIds: ["nope"] })
      .expect(400);
  });
});
