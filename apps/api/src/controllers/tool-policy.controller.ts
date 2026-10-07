import type { Request, Response } from "express";
import { z } from "zod";
import {
  createToolPolicyRuleSchema,
  reorderToolPolicyRulesSchema,
  toolPolicyPatternSchema,
  updateToolPolicyRuleSchema,
} from "@/models/tool-policies.model";
import type { ToolPoliciesService } from "@/services/tool-policies.service";
import { paginationQuerySchema } from "@/utils/pagination.util";
import { parseOrHttpError } from "@/utils/validation.util";

const ruleIdParamSchema = z
  .string({ error: "Path param 'id' must be a string." })
  .min(1, { error: "Path param 'id' must not be empty." });

const previewQuerySchema = paginationQuerySchema.pick({ limit: true }).merge(
  z.object({
    servicePattern: toolPolicyPatternSchema,
    toolPattern: toolPolicyPatternSchema,
  }),
);

export async function listToolPolicyRules(
  req: Request,
  res: Response,
): Promise<void> {
  const rules = await getToolPoliciesService(req).listRules();
  res.status(200).json(rules);
}

export async function createToolPolicyRule(
  req: Request,
  res: Response,
): Promise<void> {
  const service = getToolPoliciesService(req);
  const body = parseOrHttpError(
    createToolPolicyRuleSchema,
    req.body,
    "Request body must be an object.",
  );
  res.status(201).json(await service.createRule(body));
}

export async function updateToolPolicyRule(
  req: Request,
  res: Response,
): Promise<void> {
  const service = getToolPoliciesService(req);
  const id = parseOrHttpError(ruleIdParamSchema, req.params.id);
  const body = parseOrHttpError(
    updateToolPolicyRuleSchema,
    req.body,
    "Request body must be an object.",
  );
  res.status(200).json(await service.updateRule(id, body));
}

export async function deleteToolPolicyRule(
  req: Request,
  res: Response,
): Promise<void> {
  const service = getToolPoliciesService(req);
  const id = parseOrHttpError(ruleIdParamSchema, req.params.id);
  await service.deleteRule(id);
  res.status(204).send();
}

export async function reorderToolPolicyRules(
  req: Request,
  res: Response,
): Promise<void> {
  const service = getToolPoliciesService(req);
  const { orderedIds } = parseOrHttpError(
    reorderToolPolicyRulesSchema,
    req.body,
    "Request body must be an object.",
  );
  res.status(200).json(await service.reorderRules(orderedIds));
}

export async function getAffectedTools(
  req: Request,
  res: Response,
): Promise<void> {
  const service = getToolPoliciesService(req);
  const id = parseOrHttpError(ruleIdParamSchema, req.params.id);
  const query = parseOrHttpError(
    paginationQuerySchema,
    req.query ?? {},
    "Query parameters must be an object.",
  );
  res.status(200).json(
    await service.getAffectedTools(id, {
      limit: query.limit,
      cursor: query.cursor,
    }),
  );
}

export async function previewToolPolicyPattern(
  req: Request,
  res: Response,
): Promise<void> {
  const service = getToolPoliciesService(req);
  const query = parseOrHttpError(
    previewQuerySchema,
    req.query ?? {},
    "Query parameters must be an object.",
  );
  res.status(200).json(
    await service.previewPattern({
      servicePattern: query.servicePattern,
      toolPattern: query.toolPattern,
      limit: query.limit,
    }),
  );
}

function getToolPoliciesService(req: Request): ToolPoliciesService {
  const service = req.app.locals.toolPoliciesService as
    | ToolPoliciesService
    | undefined;

  if (!service) {
    throw new Error("ToolPoliciesService not configured in app.locals");
  }

  return service;
}
