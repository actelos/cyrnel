import fs from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/client";
import { ToolPoliciesService } from "@/services/tool-policies.service";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../drizzle");

async function applyMigrations(): Promise<void> {
  const entries = (await fs.readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of entries) {
    const file = await fs.readFile(path.join(MIGRATIONS_DIR, name), "utf8");
    const statements = file
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await db.run(sql.raw(stmt));
    }
  }
}

async function resetDb(): Promise<void> {
  await db.run(sql.raw("PRAGMA foreign_keys = OFF"));
  await db.run(sql.raw("DELETE FROM approval_requests"));
  await db.run(sql.raw("DELETE FROM tool_policy_rules"));
  await db.run(sql.raw("DELETE FROM tools"));
  await db.run(sql.raw("DELETE FROM services"));
  await db.run(sql.raw("DELETE FROM modules"));
  await db.run(sql.raw("PRAGMA foreign_keys = ON"));
}

async function seedTools(): Promise<void> {
  await db.run(
    sql`INSERT INTO modules (id, name, type, description, enabled, missing)
        VALUES ('openapi', 'openapi', 'adapter', '', 1, 0)`,
  );
  await db.run(
    sql`INSERT INTO services (id, name, description, hash, source, adapter, enabled, config_schema, secrets_schema, adapter_domain)
        VALUES ('github', 'github', '', 'h', '', 'openapi', 1, '{}', '{}', '{}')`,
  );
  await db.run(
    sql`INSERT INTO services (id, name, description, hash, source, adapter, enabled, config_schema, secrets_schema, adapter_domain)
        VALUES ('gitlab', 'gitlab', '', 'h', '', 'openapi', 1, '{}', '{}', '{}')`,
  );
  for (const [serviceId, toolId] of [
    ["github", "search"],
    ["github", "delete"],
    ["gitlab", "search"],
  ] as const) {
    await db.run(
      sql`INSERT INTO tools (service_id, id, name, description, enabled, input_schema, output_schema, adapter_domain)
          VALUES (${serviceId}, ${toolId}, ${toolId}, '', 1, '{}', '{}', '{}')`,
    );
  }
}

describe("ToolPoliciesService", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterEach(async () => {
    await resetDb();
  });

  describe("createRule / listRules", () => {
    it("appends rules at increasing positions", async () => {
      const service = new ToolPoliciesService();
      const first = await service.createRule({
        servicePattern: "github",
        toolPattern: "*",
        decision: "allow",
      });
      const second = await service.createRule({
        servicePattern: "*",
        toolPattern: "*",
        decision: "ask",
      });
      expect(first.position).toBe(0);
      expect(second.position).toBe(1);
      expect(first.id).not.toBe(second.id);

      const rules = await service.listRules();
      expect(rules.map((r) => r.id)).toEqual([first.id, second.id]);
    });
  });

  describe("updateRule", () => {
    it("updates decision and patterns", async () => {
      const service = new ToolPoliciesService();
      const created = await service.createRule({
        servicePattern: "github",
        toolPattern: "*",
        decision: "ask",
      });
      const updated = await service.updateRule(created.id, {
        decision: "block",
        toolPattern: "delete",
      });
      expect(updated.decision).toBe("block");
      expect(updated.toolPattern).toBe("delete");
      expect(updated.position).toBe(created.position);
    });

    it("returns 404 for unknown rules", async () => {
      const service = new ToolPoliciesService();
      await expect(
        service.updateRule("tpr_missing", { decision: "allow" }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe("deleteRule", () => {
    it("removes the rule and renormalizes positions densely", async () => {
      const service = new ToolPoliciesService();
      const first = await service.createRule({
        servicePattern: "a",
        toolPattern: "*",
        decision: "allow",
      });
      const second = await service.createRule({
        servicePattern: "b",
        toolPattern: "*",
        decision: "block",
      });
      const third = await service.createRule({
        servicePattern: "c",
        toolPattern: "*",
        decision: "ask",
      });
      await service.deleteRule(second.id);
      const rules = await service.listRules();
      expect(rules.map((r) => [r.id, r.position])).toEqual([
        [first.id, 0],
        [third.id, 1],
      ]);
    });

    it("returns 404 for unknown rules", async () => {
      const service = new ToolPoliciesService();
      await expect(service.deleteRule("tpr_missing")).rejects.toMatchObject({
        statusCode: 404,
      });
    });
  });

  describe("reorderRules", () => {
    it("reorders evaluation precedence; first match wins", async () => {
      const service = new ToolPoliciesService();
      await seedTools();
      const broad = await service.createRule({
        servicePattern: "github",
        toolPattern: "*",
        decision: "allow",
      });
      const narrow = await service.createRule({
        servicePattern: "github",
        toolPattern: "delete",
        decision: "block",
      });

      const affected = await service.getAffectedTools(narrow.id, {});
      const target = affected.items.find((t) => t.toolId === "delete");
      // Broad rule is first: narrow rule is shadowed.
      expect(target?.policy.decision).toBe("allow");

      const reordered = await service.reorderRules([narrow.id, broad.id]);
      expect(reordered.map((r) => r.id)).toEqual([narrow.id, broad.id]);

      const affectedAfter = await service.getAffectedTools(narrow.id, {});
      expect(
        affectedAfter.items.find((t) => t.toolId === "delete")?.policy.decision,
      ).toBe("block");
    });

    it("rejects unknown, missing, or duplicate ids", async () => {
      const service = new ToolPoliciesService();
      const only = await service.createRule({
        servicePattern: "*",
        toolPattern: "*",
        decision: "ask",
      });
      await expect(service.reorderRules(["tpr_missing"])).rejects.toMatchObject(
        { statusCode: 400 },
      );
      await expect(service.reorderRules([])).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(
        service.reorderRules([only.id, only.id]),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe("getAffectedTools", () => {
    it("returns matching tools with effective policy provenance", async () => {
      const service = new ToolPoliciesService();
      await seedTools();
      const rule = await service.createRule({
        servicePattern: "github",
        toolPattern: "*",
        decision: "allow",
      });
      const page = await service.getAffectedTools(rule.id, {});
      expect(
        page.items.map((t) => `${t.serviceId}.${t.toolId}`).sort(),
      ).toEqual(["github.delete", "github.search"]);
      for (const item of page.items) {
        expect(item.policy.decision).toBe("allow");
        expect(item.policy.source).toMatchObject({
          type: "rule",
          ruleId: rule.id,
        });
      }
      expect(page.hasMore).toBe(false);
    });

    it("paginates with cursors", async () => {
      const service = new ToolPoliciesService();
      await seedTools();
      const rule = await service.createRule({
        servicePattern: "*",
        toolPattern: "*",
        decision: "allow",
      });
      const first = await service.getAffectedTools(rule.id, { limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).not.toBeNull();
      const second = await service.getAffectedTools(rule.id, {
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.items).toHaveLength(1);
      expect(second.hasMore).toBe(false);
      const seen = new Set([
        ...first.items.map((t) => `${t.serviceId}.${t.toolId}`),
        ...second.items.map((t) => `${t.serviceId}.${t.toolId}`),
      ]);
      expect(seen).toEqual(
        new Set(["github.search", "github.delete", "gitlab.search"]),
      );
    });

    it("flags rules shadowed by higher-precedence rules", async () => {
      const service = new ToolPoliciesService();
      await seedTools();
      await service.createRule({
        servicePattern: "github",
        toolPattern: "*",
        decision: "allow",
      });
      const shadowed = await service.createRule({
        servicePattern: "github",
        toolPattern: "delete",
        decision: "block",
      });
      const page = await service.getAffectedTools(shadowed.id, {});
      const target = page.items.find((t) => t.toolId === "delete");
      expect(target?.policy.decision).toBe("allow");
      expect(target?.policy.source).toMatchObject({ type: "rule" });
      if (target?.policy.source.type === "rule") {
        expect(target.policy.source.ruleId).not.toBe(shadowed.id);
      }
    });

    it("returns 404 for unknown rules", async () => {
      const service = new ToolPoliciesService();
      await expect(
        service.getAffectedTools("tpr_missing", {}),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe("previewPattern", () => {
    it("counts and samples matches for an unsaved pattern", async () => {
      const service = new ToolPoliciesService();
      await seedTools();
      const preview = await service.previewPattern({
        servicePattern: "github",
        toolPattern: "*",
        limit: 10,
      });
      expect(preview.matchCount).toBe(2);
      expect(preview.items).toHaveLength(2);
      // No rules yet: immutable ask default with default provenance.
      for (const item of preview.items) {
        expect(item.policy.decision).toBe("ask");
        expect(item.policy.source).toEqual({ type: "default" });
      }
    });
  });
});
