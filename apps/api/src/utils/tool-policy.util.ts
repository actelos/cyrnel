import {
  type EffectiveToolPolicy,
  TOOL_POLICY_DEFAULT_DECISION,
  type ToolPolicyDecision,
  type ToolPolicyRule,
} from "@/models/tool-policies.model";

export type ToolPolicyRuleLike = Pick<
  ToolPolicyRule,
  "id" | "servicePattern" | "toolPattern" | "decision" | "position"
> & { updatedAt?: number | null };

function matchesSide(pattern: string, value: string): boolean {
  return pattern === "*" || pattern === value;
}

/** True when the rule matches both the service and the tool. */
export function matchesToolPolicyRule(
  rule: Pick<ToolPolicyRuleLike, "servicePattern" | "toolPattern">,
  serviceId: string,
  toolId: string,
): boolean {
  return (
    matchesSide(rule.servicePattern, serviceId) &&
    matchesSide(rule.toolPattern, toolId)
  );
}

function comparePosition(
  a: Pick<ToolPolicyRuleLike, "position">,
  b: Pick<ToolPolicyRuleLike, "position">,
): number {
  return a.position - b.position;
}

/**
 * Resolve the effective policy for a tool.
 * Rules are evaluated in ascending `position` order; the first
 * matching rule wins. No match yields the immutable `ask` default.
 */
export function resolveToolPolicy(
  rules: readonly ToolPolicyRuleLike[],
  serviceId: string,
  toolId: string,
): EffectiveToolPolicy {
  const ordered = [...rules].sort(comparePosition);
  for (const rule of ordered) {
    if (matchesToolPolicyRule(rule, serviceId, toolId)) {
      return {
        decision: rule.decision as ToolPolicyDecision,
        updatedAt: rule.updatedAt ?? null,
        source: {
          type: "rule",
          ruleId: rule.id,
          servicePattern: rule.servicePattern,
          toolPattern: rule.toolPattern,
          position: rule.position,
        },
      };
    }
  }
  return {
    decision: TOOL_POLICY_DEFAULT_DECISION,
    updatedAt: null,
    source: { type: "default" },
  };
}

/**
 * Batch-resolve policies for many tools sharing one rule set.
 * Returns a map keyed by `${serviceId}:${toolId}`.
 */
export function resolveToolPolicies(
  rules: readonly ToolPolicyRuleLike[],
  tools: readonly { serviceId: string; toolId: string }[],
): Map<string, EffectiveToolPolicy> {
  const ordered = [...rules].sort(comparePosition);
  const result = new Map<string, EffectiveToolPolicy>();
  for (const tool of tools) {
    const key = `${tool.serviceId}:${tool.toolId}`;
    if (!result.has(key)) {
      result.set(key, resolveToolPolicy(ordered, tool.serviceId, tool.toolId));
    }
  }
  return result;
}

/** Presentation-only `servicePattern.toolPattern` form. Never parse it back. */
export function formatToolPolicyPattern(
  rule: Pick<ToolPolicyRuleLike, "servicePattern" | "toolPattern">,
): string {
  return `${rule.servicePattern}.${rule.toolPattern}`;
}
