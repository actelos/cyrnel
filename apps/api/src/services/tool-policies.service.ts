import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { toolPolicyRules, tools } from "@/db/schema";
import { HttpError } from "@/models/error.model";
import type {
  CreateToolPolicyRuleInput,
  EffectiveToolPolicy,
  ToolPolicyRule,
  UpdateToolPolicyRuleInput,
} from "@/models/tool-policies.model";
import {
  decodeCursor,
  invalidCursorError,
  keysetConditions,
  PAGINATION_DEFAULT_LIMIT,
  type PaginatedResult,
  paginatePage,
} from "@/utils/pagination.util";
import {
  resolveToolPolicies,
  resolveToolPolicy,
} from "@/utils/tool-policy.util";

const ruleIdSchema = z
  .string({ error: "Rule id must be a string." })
  .min(1, { error: "Rule id must not be empty." });

export interface AffectedTool {
  serviceId: string;
  toolId: string;
  name: string;
  policy: EffectiveToolPolicy;
}

export interface PreviewPatternInput {
  servicePattern: string;
  toolPattern: string;
  limit?: number;
}

function toRule(row: typeof toolPolicyRules.$inferSelect): ToolPolicyRule {
  return {
    id: row.id,
    servicePattern: row.servicePattern,
    toolPattern: row.toolPattern,
    decision: row.decision as ToolPolicyRule["decision"],
    position: row.position,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function newRuleId(): string {
  return `tpr_${randomUUID().replace(/-/g, "")}`;
}

export class ToolPoliciesService {
  async listRules(): Promise<ToolPolicyRule[]> {
    const rows = await db
      .select()
      .from(toolPolicyRules)
      .orderBy(asc(toolPolicyRules.position), asc(toolPolicyRules.id))
      .catch(() => {
        throw new HttpError(500, "Failed to load tool policy rules.");
      });
    return rows.map(toRule);
  }

  async createRule(input: CreateToolPolicyRuleInput): Promise<ToolPolicyRule> {
    const now = Date.now();
    const [row] = await db
      .transaction(async (tx) => {
        // Read max(position) and insert in one transaction so two
        // overlapping creates cannot claim the same position.
        const [{ next }] = await tx
          .select({
            next: sql<number>`coalesce(max(${toolPolicyRules.position}) + 1, 0)`,
          })
          .from(toolPolicyRules);
        return tx
          .insert(toolPolicyRules)
          .values({
            id: newRuleId(),
            servicePattern: input.servicePattern,
            toolPattern: input.toolPattern,
            decision: input.decision,
            position: next,
            createdAt: new Date().toISOString(),
            updatedAt: now,
          })
          .returning();
      })
      .catch((error) => {
        if (error instanceof HttpError) throw error;
        throw new HttpError(500, "Failed to create tool policy rule.");
      });
    if (!row) throw new HttpError(500, "Failed to create tool policy rule.");
    return toRule(row);
  }

  async updateRule(
    id: string,
    patch: UpdateToolPolicyRuleInput,
  ): Promise<ToolPolicyRule> {
    const ruleId = ruleIdSchema.parse(id);
    const [row] = await db
      .update(toolPolicyRules)
      .set({
        ...(patch.servicePattern !== undefined
          ? { servicePattern: patch.servicePattern }
          : {}),
        ...(patch.toolPattern !== undefined
          ? { toolPattern: patch.toolPattern }
          : {}),
        ...(patch.decision !== undefined ? { decision: patch.decision } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(toolPolicyRules.id, ruleId))
      .returning()
      .catch(() => {
        throw new HttpError(500, `Failed to update tool policy rule.`);
      });
    if (!row) throw new HttpError(404, `Tool policy rule not found.`);
    return toRule(row);
  }

  async deleteRule(id: string): Promise<void> {
    const ruleId = ruleIdSchema.parse(id);
    await db
      .transaction(async (tx) => {
        const deleted = await tx
          .delete(toolPolicyRules)
          .where(eq(toolPolicyRules.id, ruleId))
          .returning({ id: toolPolicyRules.id });
        if (deleted.length === 0) {
          throw new HttpError(404, `Tool policy rule not found.`);
        }
        const remaining = await tx
          .select({ id: toolPolicyRules.id })
          .from(toolPolicyRules)
          .orderBy(asc(toolPolicyRules.position), asc(toolPolicyRules.id));
        for (const [index, row] of remaining.entries()) {
          await tx
            .update(toolPolicyRules)
            .set({ position: index, updatedAt: Date.now() })
            .where(eq(toolPolicyRules.id, row.id));
        }
      })
      .catch((error) => {
        if (error instanceof HttpError) throw error;
        throw new HttpError(500, `Failed to delete tool policy rule.`);
      });
  }

  /**
   * Replace the full rule ordering. `orderedIds` must contain exactly the
   * existing rule ids (no missing, unknown, or duplicate entries).
   * Position 0 is evaluated first and wins on match.
   */
  async reorderRules(orderedIds: string[]): Promise<ToolPolicyRule[]> {
    const existing = await db
      .select({ id: toolPolicyRules.id })
      .from(toolPolicyRules)
      .catch(() => {
        throw new HttpError(500, "Failed to load tool policy rules.");
      });
    const existingIds = existing.map((r) => r.id);
    const seen = new Set<string>();
    const valid =
      orderedIds.length === existingIds.length &&
      orderedIds.every((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return existingIds.includes(id);
      });
    if (!valid) {
      throw new HttpError(
        400,
        "orderedIds must contain exactly the existing rule ids, without duplicates.",
      );
    }
    const now = Date.now();
    await db
      .transaction(async (tx) => {
        for (const [position, id] of orderedIds.entries()) {
          await tx
            .update(toolPolicyRules)
            .set({ position, updatedAt: now })
            .where(eq(toolPolicyRules.id, id));
        }
      })
      .catch((error) => {
        if (error instanceof HttpError) throw error;
        throw new HttpError(500, "Failed to reorder tool policy rules.");
      });
    return this.listRules();
  }

  async getAffectedTools(
    ruleId: string,
    input: { limit?: number; cursor?: string },
  ): Promise<PaginatedResult<AffectedTool>> {
    const id = ruleIdSchema.parse(ruleId);
    const [ruleRow] = await db
      .select()
      .from(toolPolicyRules)
      .where(eq(toolPolicyRules.id, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, "Failed to load tool policy rule.");
      });
    if (!ruleRow) throw new HttpError(404, `Tool policy rule not found.`);
    return this.queryMatchingTools(
      ruleRow.servicePattern,
      ruleRow.toolPattern,
      input,
    );
  }

  async previewPattern(input: PreviewPatternInput): Promise<{
    matchCount: number;
    items: AffectedTool[];
  }> {
    const limit = input.limit ?? PAGINATION_DEFAULT_LIMIT;
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tools)
      .where(patternConditions(input.servicePattern, input.toolPattern))
      .catch(() => {
        throw new HttpError(500, "Failed to preview tool policy pattern.");
      });
    const page = await this.queryMatchingTools(
      input.servicePattern,
      input.toolPattern,
      { limit },
    );
    return { matchCount: count, items: page.items };
  }

  private async queryMatchingTools(
    servicePattern: string,
    toolPattern: string,
    input: { limit?: number; cursor?: string },
  ): Promise<PaginatedResult<AffectedTool>> {
    const limit = input.limit ?? PAGINATION_DEFAULT_LIMIT;
    let cursorPredicate: ReturnType<typeof keysetConditions> | undefined;
    if (input.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor, 2);
      const [serviceIdKey, toolIdKey] = cursor.sortKey;
      if (typeof serviceIdKey !== "string" || typeof toolIdKey !== "string") {
        throw invalidCursorError();
      }
      cursorPredicate = keysetConditions(
        [
          [tools.serviceId, serviceIdKey],
          [tools.id, toolIdKey],
        ],
        "after",
      );
    }
    const rows = await db
      .select({
        serviceId: tools.serviceId,
        toolId: tools.id,
        name: tools.name,
      })
      .from(tools)
      .where(
        and(patternConditions(servicePattern, toolPattern), cursorPredicate),
      )
      .orderBy(asc(tools.serviceId), asc(tools.id))
      .limit(limit + 1)
      .catch(() => {
        throw new HttpError(500, "Failed to load matching tools.");
      });
    const rules = await db
      .select()
      .from(toolPolicyRules)
      .orderBy(asc(toolPolicyRules.position), asc(toolPolicyRules.id))
      .catch(() => {
        throw new HttpError(500, "Failed to load tool policy rules.");
      });
    const policies = resolveToolPolicies(
      rules,
      rows.map((r) => ({ serviceId: r.serviceId, toolId: r.toolId })),
    );
    const items: AffectedTool[] = rows.map((row) => ({
      serviceId: row.serviceId,
      toolId: row.toolId,
      name: row.name,
      policy:
        policies.get(`${row.serviceId}:${row.toolId}`) ??
        resolveToolPolicy([], row.serviceId, row.toolId),
    }));
    return paginatePage(items, limit, (item) => [item.serviceId, item.toolId]);
  }
}

function patternConditions(servicePattern: string, toolPattern: string) {
  return and(
    servicePattern === "*" ? undefined : eq(tools.serviceId, servicePattern),
    toolPattern === "*" ? undefined : eq(tools.id, toolPattern),
  );
}
