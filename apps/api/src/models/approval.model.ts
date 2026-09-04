import { z } from "zod";

export const approvalStateSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "expired",
]);

export type ApprovalState = z.infer<typeof approvalStateSchema>;

export const approvalRequestSchema = z.object({
  id: z.string(),
  serviceId: z.string(),
  toolId: z.string(),
  processId: z.number().nullable(),
  parameters: z.unknown(),
  state: approvalStateSchema,
  createdAt: z.string(),
  expiresAt: z.number(),
  decidedAt: z.number().nullable(),
});

export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
