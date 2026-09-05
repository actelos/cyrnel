import { eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { z } from "zod";
import { db } from "@/db/client";
import { approvalRequests } from "@/db/schema";
import { HttpError } from "@/models/error.model";
import {
  getApproval,
  listApprovals,
  resolveApproval,
} from "@/services/approval.service";
import { paginationQuerySchema } from "@/utils/pagination.util";
import { parseOrHttpError } from "@/utils/validation.util";

const stateFilterSchema = z.enum(["pending", "approved", "denied", "expired"]);

const listQuerySchema = paginationQuerySchema.merge(
  z.object({
    state: stateFilterSchema.optional(),
    serviceId: z.string().min(1).optional(),
    toolId: z.string().min(1).optional(),
    processId: z.coerce.number().int().positive().optional(),
  }),
);

export async function listApprovalRequests(
  req: Request,
  res: Response,
): Promise<void> {
  const query = parseOrHttpError(
    listQuerySchema,
    req.query ?? {},
    "Query parameters must be an object.",
  );
  const result = await listApprovals({
    state: query.state,
    serviceId: query.serviceId,
    toolId: query.toolId,
    processId: query.processId,
    limit: query.limit,
    cursor: query.cursor,
  });
  res.status(200).json(result);
}

export async function getApprovalRequest(
  req: Request,
  res: Response,
): Promise<void> {
  const id = parseOrHttpError(z.string().min(1), req.params.id);
  const approval = await getApproval(id);
  res.status(200).json(approval);
}

export async function approveRequest(
  req: Request,
  res: Response,
): Promise<void> {
  const id = parseOrHttpError(z.string().min(1), req.params.id);
  const outcome = await resolveApproval(id, "approved");
  if (!outcome.resolved) {
    const [row] = await db
      .select({ state: approvalRequests.state })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .limit(1)
      .all()
      .catch(() => [] as { state: string }[]);
    if (!row) throw new HttpError(404, `Approval '${id}' not found.`);
    throw new HttpError(
      409,
      `Approval '${id}' is already ${row.state}.`,
      "already_decided",
    );
  }
  const approval = await getApproval(id);
  res.status(200).json(approval);
}

export async function denyRequest(req: Request, res: Response): Promise<void> {
  const id = parseOrHttpError(z.string().min(1), req.params.id);
  const outcome = await resolveApproval(id, "denied");
  if (!outcome.resolved) {
    const [row] = await db
      .select({ state: approvalRequests.state })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .limit(1)
      .all()
      .catch(() => [] as { state: string }[]);
    if (!row) throw new HttpError(404, `Approval '${id}' not found.`);
    throw new HttpError(
      409,
      `Approval '${id}' is already ${row.state}.`,
      "already_decided",
    );
  }
  const approval = await getApproval(id);
  res.status(200).json(approval);
}
