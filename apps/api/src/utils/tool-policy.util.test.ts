import { describe, expect, it } from "vitest";
import {
  formatToolPolicyPattern,
  matchesToolPolicyRule,
  resolveToolPolicies,
  resolveToolPolicy,
} from "@/utils/tool-policy.util";

function rule(
  id: string,
  servicePattern: string,
  toolPattern: string,
  decision: "allow" | "block" | "ask",
  position: number,
) {
  return { id, servicePattern, toolPattern, decision, position };
}

describe("matchesToolPolicyRule", () => {
  it("matches exact, service-wide, tool-wide, and global patterns", () => {
    expect(
      matchesToolPolicyRule(
        { servicePattern: "github", toolPattern: "search" },
        "github",
        "search",
      ),
    ).toBe(true);
    expect(
      matchesToolPolicyRule(
        { servicePattern: "github", toolPattern: "*" },
        "github",
        "anything",
      ),
    ).toBe(true);
    expect(
      matchesToolPolicyRule(
        { servicePattern: "*", toolPattern: "search" },
        "github",
        "search",
      ),
    ).toBe(true);
    expect(
      matchesToolPolicyRule(
        { servicePattern: "*", toolPattern: "*" },
        "github",
        "search",
      ),
    ).toBe(true);
    expect(
      matchesToolPolicyRule(
        { servicePattern: "github", toolPattern: "*" },
        "gitlab",
        "search",
      ),
    ).toBe(false);
    expect(
      matchesToolPolicyRule(
        { servicePattern: "*", toolPattern: "search" },
        "github",
        "delete",
      ),
    ).toBe(false);
  });
});

describe("resolveToolPolicy contract", () => {
  it("first matching rule wins; shadowing is explicit", () => {
    const rules = [
      rule("r1", "github", "*", "allow", 0),
      rule("r2", "github", "delete", "block", 1),
    ];
    // github.delete matches r1 first: r2 is shadowed.
    expect(resolveToolPolicy(rules, "github", "search").decision).toBe("allow");
    expect(resolveToolPolicy(rules, "github", "delete").decision).toBe("allow");
    expect(resolveToolPolicy(rules, "github", "delete").source).toMatchObject({
      type: "rule",
      ruleId: "r1",
      position: 0,
    });
  });

  it("a leading catch-all shadows everything below it", () => {
    const rules = [
      rule("r0", "*", "*", "ask", 0),
      rule("r1", "github", "*", "allow", 1),
    ];
    expect(resolveToolPolicy(rules, "github", "search").decision).toBe("ask");
  });

  it("reordering flips the outcome", () => {
    const rules = [
      rule("r1", "github", "delete", "block", 0),
      rule("r2", "github", "*", "allow", 1),
    ];
    expect(resolveToolPolicy(rules, "github", "delete").decision).toBe("block");
    expect(resolveToolPolicy(rules, "github", "search").decision).toBe("allow");
  });

  it("falls back to the immutable ask default with default provenance", () => {
    const resolved = resolveToolPolicy([], "github", "search");
    expect(resolved.decision).toBe("ask");
    expect(resolved.updatedAt).toBeNull();
    expect(resolved.source).toEqual({ type: "default" });
  });

  it("evaluates in position order regardless of input order", () => {
    const rules = [
      rule("r2", "github", "*", "allow", 2),
      rule("r1", "github", "delete", "block", 1),
    ];
    expect(resolveToolPolicy(rules, "github", "delete").decision).toBe("block");
  });
});

describe("resolveToolPolicies", () => {
  it("resolves many tools against one rule set", () => {
    const rules = [rule("r1", "github", "*", "allow", 0)];
    const result = resolveToolPolicies(rules, [
      { serviceId: "github", toolId: "a" },
      { serviceId: "gitlab", toolId: "b" },
    ]);
    expect(result.get("github:a")?.decision).toBe("allow");
    expect(result.get("gitlab:b")?.decision).toBe("ask");
  });
});

describe("formatToolPolicyPattern", () => {
  it("formats display-only dotted form", () => {
    expect(
      formatToolPolicyPattern({ servicePattern: "github", toolPattern: "*" }),
    ).toBe("github.*");
  });
});
