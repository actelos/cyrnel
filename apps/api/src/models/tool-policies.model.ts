import { z } from "zod";

/**
 * Tool policy rules contract.
 *
 * Rules are evaluated in ascending `position` order.
 * The first rule matching both the service and the tool wins.
 * If no rule matches, the effective decision is `ask` (immutable default).
 *
 * Grammar per side: a literal service/tool id, or exactly `"*"`.
 * Display form `servicePattern.toolPattern` (e.g. `github.*`) is
 * presentation-only: the API always transports the two patterns as
 * separate structured fields and never parses the dotted form.
 *
 * Example (order matters, first match wins):
 *   0: github.*      -> allow
 *   1: github.delete -> block
 *   github.search -> allow (rule 0)
 *   github.delete -> allow (rule 0 shadows rule 1)
 *
 * Reordered:
 *   0: github.delete -> block
 *   1: github.*      -> allow
 *   github.search -> allow (rule 1)
 *   github.delete -> block (rule 0)
 *
 * Note: a catch-all rule (e.g. *.*) at position 0 shadows every rule
 * below it. Prefer specific rules first and broad rules last.
 */

export const TOOL_POLICY_DEFAULT_DECISION = "ask" as const;

export const toolPolicyDecisionSchema = z.enum(["allow", "block", "ask"]);

export type ToolPolicyDecision = z.infer<typeof toolPolicyDecisionSchema>;

/** A single pattern side: a literal id or exactly `"*"`. Dots are allowed (presentation-only separator). */
export const toolPolicyPatternSchema = z
  .string({ error: "Pattern must be a string." })
  .trim()
  .min(1, { error: "Pattern must not be empty." })
  .max(128, { error: "Pattern must be at most 128 characters." })
  .refine((value) => value === "*" || !value.includes("*"), {
    error: 'Pattern must be a literal id or exactly "*".',
  });

export type ToolPolicyPattern = z.infer<typeof toolPolicyPatternSchema>;

export const toolPolicyRuleSchema = z.object({
  id: z.string(),
  servicePattern: toolPolicyPatternSchema,
  toolPattern: toolPolicyPatternSchema,
  decision: toolPolicyDecisionSchema,
  /** Dense rank, 0-based. Lower = evaluated first = wins. */
  position: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.number(),
});

export type ToolPolicyRule = z.infer<typeof toolPolicyRuleSchema>;

export const createToolPolicyRuleSchema = z.object({
  servicePattern: toolPolicyPatternSchema,
  toolPattern: toolPolicyPatternSchema,
  decision: toolPolicyDecisionSchema,
});

export type CreateToolPolicyRuleInput = z.infer<
  typeof createToolPolicyRuleSchema
>;

export const updateToolPolicyRuleSchema = z
  .object({
    servicePattern: toolPolicyPatternSchema.optional(),
    toolPattern: toolPolicyPatternSchema.optional(),
    decision: toolPolicyDecisionSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    error: "At least one field must be provided.",
  });

export type UpdateToolPolicyRuleInput = z.infer<
  typeof updateToolPolicyRuleSchema
>;

export const reorderToolPolicyRulesSchema = z.object({
  orderedIds: z
    .array(z.string().min(1, { error: "Rule id must not be empty." }))
    .min(1, { error: "orderedIds must not be empty." }),
});

export type ReorderToolPolicyRulesInput = z.infer<
  typeof reorderToolPolicyRulesSchema
>;

export const toolPolicySourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("rule"),
    ruleId: z.string(),
    servicePattern: z.string(),
    toolPattern: z.string(),
    position: z.number().int().min(0),
  }),
  z.object({ type: z.literal("default") }),
]);

export type ToolPolicySource = z.infer<typeof toolPolicySourceSchema>;

export const effectiveToolPolicySchema = z.object({
  decision: toolPolicyDecisionSchema,
  updatedAt: z.number().nullable(),
  source: toolPolicySourceSchema,
});

export type EffectiveToolPolicy = z.infer<typeof effectiveToolPolicySchema>;
