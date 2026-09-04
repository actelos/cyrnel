import { z } from "zod";

export const toolPolicyDecisionSchema = z.enum(["allow", "block", "ask"]);

export type ToolPolicyDecision = z.infer<typeof toolPolicyDecisionSchema>;

export const toolPolicySchema = z.object({
  serviceId: z.string(),
  toolId: z.string(),
  decision: toolPolicyDecisionSchema,
  createdAt: z.string(),
  updatedAt: z.number(),
});

export type ToolPolicy = z.infer<typeof toolPolicySchema>;
